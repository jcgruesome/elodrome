import type { Config } from '../config'
import { NimError, type NimClient } from '../nim/client'
import { invalidReasons, validateChanges } from '../patch/validate'
import { runCritique } from '../pipeline/critique'
import type { ModelEntry } from '../registry/schema'
import type { Sandbox } from '../sandbox/sandbox'
import { verifyChanges, verifyFailureMessages, type VerifyResult } from '../verify'
import { addStats, runWorkerLoop, WorkerError, type WorkerStats } from '../worker/loop'
import { anonymizeEntries, runJudgePanel, type ArenaEntry } from './judge'

export interface ForfeitRecord { model: string; kind: 'no_contest' | 'loss'; reason: string }

export class ArenaAbortError extends Error {
  constructor(public forfeits: ForfeitRecord[]) {
    super(`All contestants forfeited: ${forfeits.map((f) => `${f.model} (${f.kind}: ${f.reason})`).join('; ')}`)
  }
}

export interface RankingRow {
  model: string
  label?: string
  place: number | null
  forfeit?: 'no_contest' | 'loss'
  forfeitReason?: string
}

export interface ArenaOutcome {
  winner: ArenaEntry
  winnerVerdictPass: boolean
  revised: boolean
  ranking: RankingRow[]
  judges: string[]
  judgeIssues: Record<string, string[]>
  agreement: boolean | null
  usage: { contestants: Record<string, WorkerStats>; judges: WorkerStats }
  verify: Record<string, VerifyResult>
  verifyRevisionUsed: Record<string, boolean>
}

export interface ArenaOptions {
  client: Pick<NimClient, 'chat'>
  config: Config
  sandbox: Sandbox
  task: string
  runId: string
  contestants: ModelEntry[]
  judgePool: ModelEntry[]
  scrubNames: string[]
  briefings?: Record<string, string>
}

const ZERO: WorkerStats = { requests: 0, promptTokens: 0, completionTokens: 0 }

export async function runArena(opts: ArenaOptions): Promise<ArenaOutcome> {
  const settled = await Promise.allSettled(opts.contestants.map((m) => runWorkerLoop({
    client: opts.client,
    model: m.id,
    task: opts.task,
    sandbox: opts.sandbox,
    maxRequests: opts.config.maxWorkerRequests,
    timeoutMs: opts.config.workerTimeoutMs,
    briefing: opts.briefings?.[m.id],
  })))

  const rawEntries: ArenaEntry[] = []
  const forfeits: ForfeitRecord[] = []
  const usage: ArenaOutcome['usage'] = { contestants: {}, judges: ZERO }

  settled.forEach((s, i) => {
    const model = opts.contestants[i]!.id
    if (s.status === 'fulfilled') {
      usage.contestants[model] = s.value.stats
      rawEntries.push({
        model,
        result: s.value.result,
        changes: validateChanges(opts.sandbox, s.value.result.changes),
        stats: s.value.stats,
      })
    } else if (s.reason instanceof NimError) {
      forfeits.push({ model, kind: 'no_contest', reason: s.reason.message })
    } else if (s.reason instanceof WorkerError) {
      forfeits.push({ model, kind: 'loss', reason: s.reason.message })
    } else {
      throw s.reason
    }
  })

  const verify: Record<string, VerifyResult> = {}
  const verifyRevisionUsed: Record<string, boolean> = {}
  const entries: ArenaEntry[] = []
  await Promise.all(rawEntries.map(async (raw) => {
    if (!raw.changes.every((c) => c.valid)) {
      entries.push(raw)
      return
    }
    let result = await verifyChanges(opts.sandbox, raw.changes, opts.config.verifyTimeoutMs)
    let current = raw
    if (result.status === 'failed') {
      verifyRevisionUsed[raw.model] = true
      current = await revise(opts, raw, verifyFailureMessages(result))
      result = current.changes.every((c) => c.valid)
        ? await verifyChanges(opts.sandbox, current.changes, opts.config.verifyTimeoutMs)
        : { status: 'skipped', checks: [] }
    }
    verify[raw.model] = result
    usage.contestants[raw.model] = current.stats
    if (result.status === 'failed') {
      forfeits.push({
        model: raw.model,
        kind: 'loss',
        reason: `failed verification: ${verifyFailureMessages(result).join('; ')}`,
      })
      return
    }
    entries.push(current)
  }))

  if (entries.length === 0) throw new ArenaAbortError(forfeits)
  if (entries.length === 1) return singleSurvivor(opts, entries[0]!, forfeits, usage, verify, verifyRevisionUsed)

  const anon = anonymizeEntries(entries, opts.runId, opts.scrubNames)
  const panel = await runJudgePanel(opts.client, opts.judgePool.map((j) => j.id), opts.task, anon)
  usage.judges = panel.usage

  const modelOf = new Map(anon.map((e) => [e.label, e.model]))
  const orderedModels = panel.ranking.map((l) => modelOf.get(l)!)
  const winnerLabel = panel.ranking[0]!
  let winner = entries.find((e) => e.model === orderedModels[0])!
  const winnerVerdictPass = panel.verdicts[winnerLabel] === 'pass'
  let revised = false
  if (!winnerVerdictPass) {
    revised = true
    winner = await revise(opts, winner, panel.issues[winnerLabel] ?? [])
    usage.contestants[winner.model] = winner.stats
  }

  return {
    winner,
    winnerVerdictPass,
    revised,
    ranking: buildRanking(orderedModels, panel.ranking, forfeits, orderedModels.length),
    judges: panel.judges,
    judgeIssues: Object.fromEntries([...modelOf.entries()].map(([label, m]) => [m, panel.issues[label] ?? []])),
    agreement: panel.agreement,
    usage,
    verify,
    verifyRevisionUsed,
  }
}

async function singleSurvivor(
  opts: ArenaOptions,
  survivor: ArenaEntry,
  forfeits: ForfeitRecord[],
  usage: ArenaOutcome['usage'],
  verify: Record<string, VerifyResult>,
  verifyRevisionUsed: Record<string, boolean>,
): Promise<ArenaOutcome> {
  const reviewer = opts.judgePool[0]!
  let entry = survivor
  let { critique, usage: cUsage } = await runCritique(opts.client, reviewer.id, opts.task, entry.result)
  usage.judges = addStats(usage.judges, cUsage)
  let revised = false
  const problems = [
    ...(critique.verdict === 'fail' ? critique.issues : []),
    ...invalidReasons(entry.changes),
  ]
  if (problems.length > 0) {
    revised = true
    entry = await revise(opts, entry, problems)
    usage.contestants[entry.model] = entry.stats
    const second = await runCritique(opts.client, reviewer.id, opts.task, entry.result)
    critique = second.critique
    usage.judges = addStats(usage.judges, second.usage)
  }
  return {
    winner: entry,
    winnerVerdictPass: critique.verdict === 'pass',
    revised,
    ranking: buildRanking([entry.model], undefined, forfeits, 1),
    judges: [reviewer.id],
    judgeIssues: { [entry.model]: critique.issues },
    agreement: null,
    usage,
    verify,
    verifyRevisionUsed,
  }
}

export async function revise(opts: ArenaOptions, entry: ArenaEntry, issues: string[]): Promise<ArenaEntry> {
  const task = `${opts.task}\n\nYour previous attempt (summary: "${entry.result.summary}") `
    + `was rejected in review. Fix ALL of these issues and resubmit:\n`
    + issues.map((p) => `- ${p}`).join('\n')
  const { result, stats } = await runWorkerLoop({
    client: opts.client,
    model: entry.model,
    task,
    sandbox: opts.sandbox,
    maxRequests: opts.config.maxWorkerRequests,
    timeoutMs: opts.config.workerTimeoutMs,
    briefing: opts.briefings?.[entry.model],
  })
  return {
    model: entry.model,
    result,
    changes: validateChanges(opts.sandbox, result.changes),
    stats: addStats(entry.stats, stats),
  }
}

function buildRanking(
  orderedModels: string[],
  labels: string[] | undefined,
  forfeits: ForfeitRecord[],
  survivorCount: number,
): RankingRow[] {
  return [
    ...orderedModels.map((m, i) => ({ model: m, label: labels?.[i], place: i + 1 })),
    ...forfeits.map((f) => ({
      model: f.model,
      place: f.kind === 'loss' ? survivorCount + 1 : null,
      forfeit: f.kind,
      forfeitReason: f.reason,
    })),
  ]
}
