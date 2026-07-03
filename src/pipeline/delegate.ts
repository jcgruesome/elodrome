import type { Config } from '../config'
import { ArenaAbortError, runArena, type RankingRow } from '../arena/arena'
import { addAvailabilityStrike, applyTournament, type TournamentResult } from '../arena/elo'
import { decide, selectJudges } from '../arena/select'
import type { NimClient } from '../nim/client'
import { invalidReasons, validateChanges, type ValidatedChange } from '../patch/validate'
import type { CapabilityTag, ModelEntry, Registry } from '../registry/schema'
import { getRating, loadState, withStateLock } from '../registry/state'
import { Sandbox, validateWorkspace } from '../sandbox/sandbox'
import { appendTrace, newRunId } from '../trace/trace'
import { addStats, runWorkerLoop, type WorkerStats } from '../worker/loop'
import { runCritique, type Critique } from './critique'

export interface DelegateRequest {
  task: string
  workspace: string
  taskProfile: CapabilityTag[]
  model?: string
}

export interface DelegateDeps {
  config: Config
  catalog: Registry
  statePath: string
  client: Pick<NimClient, 'chat'>
  launchDir?: string
}

export interface StatsBreakdown {
  worker: WorkerStats
  reviewer: WorkerStats
}

export interface ArenaInfo {
  contestants: string[]
  ranking: RankingRow[]
  judges: string[]
  judgeIssues: Record<string, string[]>
  agreement: boolean | null
  eloDeltas: Record<string, number>
}

export interface DelegateResponse {
  runId: string
  status: 'ok' | 'failed_review'
  mode: 'single' | 'tournament'
  workerModel: string
  reviewerModel: string
  summary: string
  rationale: string
  changes: ValidatedChange[]
  critique: Critique
  revised: boolean
  stats: WorkerStats
  statsBreakdown: StatsBreakdown
  taskProfile: CapabilityTag[]
  arena?: ArenaInfo
}

const ZERO: WorkerStats = { requests: 0, promptTokens: 0, completionTokens: 0 }

export async function delegate(deps: DelegateDeps, req: DelegateRequest): Promise<DelegateResponse> {
  const root = validateWorkspace(req.workspace, deps.launchDir)
  const sandbox = new Sandbox(root)
  const state = loadState(deps.statePath, deps.catalog)
  const runId = newRunId()

  if (req.model) {
    const worker = explicitWorker(deps.catalog, req.model)
    const reviewer = selectJudges(deps.catalog, state, [worker.id])[0]!
    return singleDelegate(deps, req, sandbox, runId, worker, reviewer)
  }

  const decision = decide(deps.catalog, state, req.taskProfile)
  if (decision.mode === 'single') {
    const reviewer = selectJudges(deps.catalog, state, [decision.model.id])[0]!
    return singleDelegate(deps, req, sandbox, runId, decision.model, reviewer)
  }

  const judges = selectJudges(deps.catalog, state, decision.contestants.map((c) => c.id))
  const scrubNames = deps.catalog.models.flatMap((m) => [m.id, m.name])
  let outcome
  try {
    outcome = await runArena({
      client: deps.client, config: deps.config, sandbox, task: req.task, runId,
      contestants: decision.contestants, judgePool: judges, scrubNames,
    })
  } catch (err) {
    if (err instanceof ArenaAbortError) {
      appendTrace(deps.config.runsDir, {
        kind: 'tournament', runId, status: 'aborted', taskProfile: req.taskProfile,
        contestants: decision.contestants.map((c) => c.id), forfeits: err.forfeits,
      })
      try {
        await withStateLock(deps.statePath, deps.catalog, (s) => ({
          state: err.forfeits
            .filter((f) => f.kind === 'no_contest')
            .reduce((acc, f) => addAvailabilityStrike(acc, f.model), s),
          result: null,
        }))
      } catch (lockErr) {
        // The abort must surface as-is; note the strike-recording failure on it.
        err.message += ` (strike recording failed: ${(lockErr as Error).message})`
      }
    }
    throw err
  }

  const primary = req.taskProfile[0]!
  const results: TournamentResult[] = outcome.ranking.map((r) => ({ model: r.model, place: r.place }))
  const eloDeltas = await withStateLock(deps.statePath, deps.catalog, (s) => {
    const before = Object.fromEntries(results.map((r) => [r.model, getRating(s, r.model, primary).elo]))
    let next = applyTournament(s, req.taskProfile, results)
    for (const row of outcome.ranking) {
      if (row.forfeit === 'no_contest') next = addAvailabilityStrike(next, row.model)
    }
    const deltas = Object.fromEntries(
      results.map((r) => [r.model, getRating(next, r.model, primary).elo - before[r.model]!]),
    )
    return { state: next, result: deltas }
  })

  const winnerValid = outcome.winner.changes.every((c) => c.valid)
  const status = winnerValid && (outcome.winnerVerdictPass || outcome.revised) ? 'ok' as const : 'failed_review' as const
  const workerStats = Object.values(outcome.usage.contestants).reduce(addStats, ZERO)
  const stats = addStats(workerStats, outcome.usage.judges)
  const critique: Critique = {
    verdict: outcome.winnerVerdictPass ? 'pass' : 'fail',
    issues: outcome.judgeIssues[outcome.winner.model] ?? [],
  }

  appendTrace(deps.config.runsDir, {
    kind: 'tournament', runId, status, taskProfile: req.taskProfile,
    workerModel: outcome.winner.model, judges: outcome.judges,
    contestants: decision.contestants.map((c) => c.id),
    ranking: outcome.ranking, agreement: outcome.agreement, revised: outcome.revised,
    requests: stats.requests, promptTokens: stats.promptTokens, completionTokens: stats.completionTokens,
    worker: workerStats, reviewer: outcome.usage.judges,
    eloDeltas, changeCount: outcome.winner.changes.length,
  })

  return {
    runId, status, mode: 'tournament',
    workerModel: outcome.winner.model,
    reviewerModel: outcome.judges[0]!,
    summary: outcome.winner.result.summary,
    rationale: outcome.winner.result.rationale,
    changes: outcome.winner.changes,
    critique, revised: outcome.revised, stats,
    statsBreakdown: { worker: workerStats, reviewer: outcome.usage.judges },
    taskProfile: req.taskProfile,
    arena: {
      contestants: decision.contestants.map((c) => c.id),
      ranking: outcome.ranking, judges: outcome.judges,
      judgeIssues: outcome.judgeIssues, agreement: outcome.agreement, eloDeltas,
    },
  }
}

async function singleDelegate(
  deps: DelegateDeps,
  req: DelegateRequest,
  sandbox: Sandbox,
  runId: string,
  worker: ModelEntry,
  reviewer: ModelEntry,
): Promise<DelegateResponse> {
  const attempt = async (task: string, prior: StatsBreakdown | undefined) => {
    const { result, stats } = await runWorkerLoop({
      client: deps.client, model: worker.id, task, sandbox,
      maxRequests: deps.config.maxWorkerRequests, timeoutMs: deps.config.workerTimeoutMs,
    })
    const changes = validateChanges(sandbox, result.changes)
    const { critique, usage } = await runCritique(deps.client, reviewer.id, req.task, result)
    const breakdown: StatsBreakdown = {
      worker: prior ? addStats(prior.worker, stats) : stats,
      reviewer: prior ? addStats(prior.reviewer, usage) : usage,
    }
    return { result, changes, critique, breakdown, stats: addStats(breakdown.worker, breakdown.reviewer) }
  }

  let round = await attempt(req.task, undefined)
  let revised = false
  const problems = [
    ...(round.critique.verdict === 'fail' ? round.critique.issues : []),
    ...invalidReasons(round.changes),
  ]
  if (problems.length > 0) {
    revised = true
    const revisionTask = `${req.task}\n\nYour previous attempt (summary: "${round.result.summary}") `
      + `was rejected in review. Fix ALL of these issues and resubmit:\n`
      + problems.map((p) => `- ${p}`).join('\n')
    round = await attempt(revisionTask, round.breakdown)
  }

  const finalOk = round.critique.verdict === 'pass' && round.changes.every((c) => c.valid)
  appendTrace(deps.config.runsDir, {
    kind: 'delegate', runId, workerModel: worker.id, reviewerModel: reviewer.id,
    status: finalOk ? 'ok' : 'failed_review', revised, taskProfile: req.taskProfile,
    requests: round.stats.requests, promptTokens: round.stats.promptTokens,
    completionTokens: round.stats.completionTokens,
    worker: round.breakdown.worker, reviewer: round.breakdown.reviewer,
    changeCount: round.changes.length,
  })
  return {
    runId,
    status: finalOk ? 'ok' : 'failed_review',
    mode: 'single',
    workerModel: worker.id,
    reviewerModel: reviewer.id,
    summary: round.result.summary,
    rationale: round.result.rationale,
    changes: round.changes,
    critique: round.critique,
    revised,
    stats: round.stats,
    statsBreakdown: round.breakdown,
    taskProfile: req.taskProfile,
  }
}

function explicitWorker(catalog: Registry, modelId: string): ModelEntry {
  const entry = catalog.models.find((m) => m.id === modelId)
  if (!entry) throw new Error(`Model "${modelId}" is not in the registry. Call list_models.`)
  if (entry.toolCalling !== 'reliable') {
    throw new Error(`Model "${modelId}" does not have reliable tool calling and cannot run agentic tasks. Pick a model with toolCalling: reliable.`)
  }
  return entry
}
