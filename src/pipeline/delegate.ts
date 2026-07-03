import type { Config } from '../config'
import type { NimClient } from '../nim/client'
import { validateChanges, type ValidatedChange } from '../patch/validate'
import { selectModel } from '../registry/registry'
import type { CapabilityTag, ModelEntry, Registry } from '../registry/schema'
import { Sandbox, validateWorkspace } from '../sandbox/sandbox'
import { appendTrace, newRunId } from '../trace/trace'
import { runWorkerLoop, type WorkerStats } from '../worker/loop'
import { runCritique, type Critique } from './critique'

export interface DelegateRequest {
  task: string
  workspace: string
  taskProfile: CapabilityTag[]
  model?: string
}

export interface DelegateDeps {
  config: Config
  registry: Registry
  client: Pick<NimClient, 'chat'>
  launchDir?: string
}

export interface StatsBreakdown {
  worker: WorkerStats
  reviewer: WorkerStats
}

export interface DelegateResponse {
  runId: string
  status: 'ok' | 'failed_review'
  workerModel: string
  reviewerModel: string
  summary: string
  rationale: string
  changes: ValidatedChange[]
  critique: Critique
  revised: boolean
  stats: WorkerStats
  statsBreakdown: StatsBreakdown
}

const addStats = (a: WorkerStats, b: WorkerStats): WorkerStats => ({
  requests: a.requests + b.requests,
  promptTokens: a.promptTokens + b.promptTokens,
  completionTokens: a.completionTokens + b.completionTokens,
})

export async function delegate(deps: DelegateDeps, req: DelegateRequest): Promise<DelegateResponse> {
  const root = validateWorkspace(req.workspace, deps.launchDir)
  const sandbox = new Sandbox(root)
  const worker = pickWorker(deps.registry, req)
  const reviewer = selectModel(deps.registry, ['review'], { excludeId: worker.id })
  const runId = newRunId()

  const attempt = async (task: string, prior: StatsBreakdown | undefined) => {
    const { result, stats } = await runWorkerLoop({
      client: deps.client,
      model: worker.id,
      task,
      sandbox,
      maxRequests: deps.config.maxWorkerRequests,
      timeoutMs: deps.config.workerTimeoutMs,
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

  const invalidReasons = (changes: ValidatedChange[]) =>
    changes.filter((c) => !c.valid).map((c) => `invalid patch for ${c.path}: ${c.reason}`)

  const problems = [...round.critique.verdict === 'fail' ? round.critique.issues : [], ...invalidReasons(round.changes)]
  if (problems.length > 0) {
    revised = true
    const revisionTask = `${req.task}\n\nYour previous attempt (summary: "${round.result.summary}") `
      + `was rejected in review. Fix ALL of these issues and resubmit:\n`
      + problems.map((p) => `- ${p}`).join('\n')
    round = await attempt(revisionTask, round.breakdown)
  }

  const finalOk = round.critique.verdict === 'pass' && round.changes.every((c) => c.valid)
  const response: DelegateResponse = {
    runId,
    status: finalOk ? 'ok' : 'failed_review',
    workerModel: worker.id,
    reviewerModel: reviewer.id,
    summary: round.result.summary,
    rationale: round.result.rationale,
    changes: round.changes,
    critique: round.critique,
    revised,
    stats: round.stats,
    statsBreakdown: round.breakdown,
  }
  appendTrace(deps.config.runsDir, {
    kind: 'delegate',
    runId,
    workerModel: worker.id,
    reviewerModel: reviewer.id,
    status: response.status,
    revised,
    requests: round.stats.requests,
    promptTokens: round.stats.promptTokens,
    completionTokens: round.stats.completionTokens,
    worker: round.breakdown.worker,
    reviewer: round.breakdown.reviewer,
    changeCount: round.changes.length,
  })
  return response
}

function pickWorker(registry: Registry, req: DelegateRequest): ModelEntry {
  if (req.model) {
    const entry = registry.models.find((m) => m.id === req.model)
    if (!entry) throw new Error(`Model "${req.model}" is not in the registry. Call list_models.`)
    if (entry.toolCalling !== 'reliable') {
      throw new Error(`Model "${req.model}" does not have reliable tool calling and cannot run agentic tasks. Pick a model with toolCalling: reliable.`)
    }
    return entry
  }
  return selectModel(registry, req.taskProfile, { requireTools: true })
}
