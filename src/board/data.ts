import fs from 'node:fs'
import path from 'node:path'
import type { Registry } from '../registry/schema'
import type { NvState } from '../registry/state'

export interface BoutRanking {
  model: string
  place: number | null
  forfeit?: string
  forfeitReason?: string
  delta?: number
}

export interface Bout {
  runId: string
  ts: string
  mode: 'tournament' | 'single'
  status: string
  taskProfile: string[]
  workerModel: string
  judges: string[]
  agreement: boolean | null
  revised: boolean
  ranking: BoutRanking[]
  requests: number
  promptTokens: number
  completionTokens: number
  outcome?: 'accepted' | 'reworked' | 'rejected'
  learning?: string
}

export interface BoardData {
  generatedAt: string
  repo: string
  bouts: Bout[]
  counters: {
    runs: number; tournaments: number; singles: number; aborted: number
    requests: number; promptTokens: number; completionTokens: number
    sonnetEquivUsd: number; opusEquivUsd: number
  }
  ladders: Array<{ tag: string; rows: Array<{ rank: number; id: string; elo: number; matches: number }> }>
  record: { accepted: number; reworked: number; rejected: number }
  scouting: Array<{ model: string; note: string; ts: string }>
  judgeAgreement: { agree: number; total: number }
  corruptLines: number
}

const MAX_BOUTS = 8

type Rec = Record<string, unknown>

// Trace records are untrusted JSON.parse() output cast into typed shapes with `as`
// casts elsewhere in this file. Those casts are compile-time only — a corrupted or
// tampered trace line can put any value (wrong type, HTML/script string, object,
// null) where a string/number/array is expected. These helpers coerce at the
// boundary so every field on a constructed Bout/BoutRanking actually matches its
// declared type at runtime, closing both the XSS class (wrong-type value rendered
// raw) and the crash class (render.ts helpers throwing on unexpected shapes).
function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

function asFiniteNumberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

function asRecordArray(v: unknown): Rec[] {
  return Array.isArray(v) ? v.filter((x): x is Rec => typeof x === 'object' && x !== null) : []
}

function readRecords(runsDir: string): { records: Rec[]; corruptLines: number } {
  if (!fs.existsSync(runsDir)) return { records: [], corruptLines: 0 }
  const records: Rec[] = []
  let corruptLines = 0
  for (const file of fs.readdirSync(runsDir).filter((f) => f.endsWith('.jsonl')).sort()) {
    for (const line of fs.readFileSync(path.join(runsDir, file), 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        records.push(JSON.parse(line) as Rec)
      } catch {
        corruptLines += 1
      }
    }
  }
  return { records, corruptLines }
}

function toBoutRanking(r: Rec, deltas: Record<string, number>): BoutRanking {
  const model = asString(r.model)
  const forfeit = asString(r.forfeit)
  const forfeitReason = asString(r.forfeitReason)
  return {
    model,
    place: asFiniteNumberOrNull(r.place),
    delta: deltas[model],
    ...(forfeit ? { forfeit } : {}),
    ...(forfeitReason ? { forfeitReason } : {}),
  }
}

function toBout(rec: Rec, outcomes: Map<string, Rec>): Bout {
  const deltas = (rec.eloDeltas ?? {}) as Record<string, number>
  const ranking: BoutRanking[] = rec.kind === 'tournament'
    ? asRecordArray(rec.ranking).map((r) => toBoutRanking(r, deltas))
    : [{ model: asString(rec.workerModel), place: 1 }]
  const outcome = outcomes.get(rec.runId as string)
  const learning = outcome ? asString(outcome.learning) : ''
  // `??` only guards null/undefined, so a `judges` value that's present but the
  // wrong shape (e.g. a string) intentionally falls through to asStringArray's
  // own [] fallback below, rather than being treated as "absent" and masked by
  // the reviewerModel fallback.
  const judges = rec.judges !== undefined && rec.judges !== null
    ? asStringArray(rec.judges)
    : [asString(rec.reviewerModel)].filter(Boolean)
  return {
    runId: rec.runId as string,
    ts: asString(rec.ts),
    mode: rec.kind === 'tournament' ? 'tournament' : 'single',
    status: (rec.status as string) ?? 'ok',
    taskProfile: asStringArray(rec.taskProfile),
    workerModel: (rec.workerModel as string) ?? '',
    judges,
    agreement: (rec.agreement as boolean | null) ?? null,
    revised: Boolean(rec.revised),
    ranking,
    requests: (rec.requests as number) ?? 0,
    promptTokens: (rec.promptTokens as number) ?? 0,
    completionTokens: (rec.completionTokens as number) ?? 0,
    ...(outcome ? { outcome: outcome.outcome as Bout['outcome'] } : {}),
    ...(learning ? { learning } : {}),
  }
}

export function buildBoardData(
  runsDir: string,
  catalog: Registry,
  state: NvState,
  opts: { days?: number; repo?: string } = {},
): BoardData {
  const { records, corruptLines: parseErrors } = readRecords(runsDir)
  const outcomes = new Map(records.filter((r) => r.kind === 'outcome').map((r) => [r.runId as string, r]))
  const candidates = records.filter((r) => r.kind === 'tournament' || r.kind === 'delegate')
  // A run record must carry its identity to be reportable: runId always, and
  // workerModel too unless the tournament was aborted before a winner existed
  // (the forfeit path in delegate.ts never sets workerModel — that's expected,
  // not corruption). Records failing this are indistinguishable from
  // incomplete/buggy trace data, so they're excluded and counted as corrupt.
  const hasIdentity = (r: Rec) => {
    if (typeof r.runId !== 'string' || r.runId === '') return false
    if (r.status === 'aborted') return true
    return typeof r.workerModel === 'string' && r.workerModel !== ''
  }
  const runs = candidates.filter(hasIdentity)
  const corruptLines = parseErrors + (candidates.length - runs.length)
  const completed = runs.filter((r) => r.status !== 'aborted')

  const cutoff = opts.days !== undefined ? Date.now() - opts.days * 86_400_000 : undefined
  const bouts = completed
    .filter((r) => cutoff === undefined || Date.parse((r.ts as string) ?? '') >= cutoff)
    .map((r) => toBout(r, outcomes))
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, MAX_BOUTS)

  const sum = (k: string) => runs.reduce((acc, r) => acc + ((r[k] as number) ?? 0), 0)
  const promptTokens = sum('promptTokens')
  const completionTokens = sum('completionTokens')
  const counters = {
    runs: runs.length,
    tournaments: runs.filter((r) => r.kind === 'tournament').length,
    singles: runs.filter((r) => r.kind === 'delegate').length,
    aborted: runs.filter((r) => r.status === 'aborted').length,
    requests: sum('requests'),
    promptTokens,
    completionTokens,
    sonnetEquivUsd: promptTokens / 1e6 * 3 + completionTokens / 1e6 * 15,
    opusEquivUsd: promptTokens / 1e6 * 15 + completionTokens / 1e6 * 75,
  }

  const tags = [...new Set(catalog.models.flatMap((m) => m.tags))].sort()
  const ladders = tags
    .map((tag) => ({
      tag,
      rows: catalog.models
        .map((m) => ({ m, rating: state.models[m.id]?.ratings[tag] }))
        .filter((x): x is { m: typeof x.m; rating: NonNullable<typeof x.rating> } => x.rating !== undefined)
        .sort((a, b) => b.rating.elo - a.rating.elo || a.m.id.localeCompare(b.m.id))
        .slice(0, 5)
        .map((x, i) => ({ rank: i + 1, id: x.m.id, elo: x.rating.elo, matches: x.rating.matches })),
    }))
    .filter((l) => l.rows.length > 0)

  const record = { accepted: 0, reworked: 0, rejected: 0 }
  for (const o of outcomes.values()) {
    const v = o.outcome as keyof typeof record
    if (v in record) record[v] += 1
  }

  const scouting = Object.entries(state.models)
    .flatMap(([model, ms]) => {
      const last = ms.learnings.at(-1)
      return last ? [{ model, note: last.note, ts: last.ts }] : []
    })
    .sort((a, b) => b.ts.localeCompare(a.ts))

  return {
    generatedAt: new Date().toISOString(),
    repo: opts.repo ?? path.basename(process.cwd()),
    bouts,
    counters,
    ladders,
    record,
    scouting,
    judgeAgreement: state.judgeAgreement,
    corruptLines,
  }
}
