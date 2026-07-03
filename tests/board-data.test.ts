import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildBoardData } from '../src/board/data'
import type { Registry } from '../src/registry/schema'
import type { NvState } from '../src/registry/state'

const catalog: Registry = {
  version: 1,
  models: [
    { id: 'a/x', name: 'X', tags: ['code-gen'], contextWindow: 1, toolCalling: 'reliable', outcomes: { accepted: 0, reworked: 0, rejected: 0 } },
    { id: 'b/y', name: 'Y', tags: ['code-gen', 'review'], contextWindow: 1, toolCalling: 'reliable', outcomes: { accepted: 0, reworked: 0, rejected: 0 } },
  ],
}

const state: NvState = {
  version: 1,
  judgeAgreement: { agree: 1, total: 2 },
  models: {
    'a/x': {
      ratings: { 'code-gen': { elo: 1016, matches: 2 } },
      outcomes: { accepted: 0, reworked: 0, rejected: 0 }, availabilityStrikes: 0,
      learnings: [{ ts: '2026-07-03T01:00:00Z', note: 'fabricates when under-reading', tags: [] }],
    },
    'b/y': { ratings: { 'code-gen': { elo: 984, matches: 2 } }, outcomes: { accepted: 0, reworked: 0, rejected: 0 }, availabilityStrikes: 1, learnings: [] },
  },
}

function writeTraces(lines: unknown[]): string {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'board-')), 'runs')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, '2026-07-03.jsonl'),
    lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n')
  return dir
}

const tournament = {
  ts: '2026-07-03T02:00:00Z', kind: 'tournament', runId: 'run_a_00000001', status: 'ok',
  taskProfile: ['code-gen'], workerModel: 'a/x', judges: ['b/y'],
  contestants: ['a/x', 'b/y'], agreement: true, revised: false,
  ranking: [{ model: 'a/x', place: 1 }, { model: 'b/y', place: 2 }],
  requests: 4, promptTokens: 1000, completionTokens: 200,
  eloDeltas: { 'a/x': 16, 'b/y': -16 }, changeCount: 1,
}

describe('buildBoardData', () => {
  it('joins bouts with outcomes and merges deltas', () => {
    const dir = writeTraces([
      tournament,
      { ts: '2026-07-03T02:10:00Z', kind: 'outcome', runId: 'run_a_00000001', outcome: 'reworked', learning: 'missed an edge case' },
      { ts: '2026-07-03T03:00:00Z', kind: 'delegate', runId: 'run_b_00000002', status: 'ok', taskProfile: ['code-gen'], workerModel: 'b/y', reviewerModel: 'a/x', revised: false, requests: 2, promptTokens: 500, completionTokens: 100 },
      'this line is not json{{{',
      { ts: '2026-07-03T04:00:00Z', kind: 'tournament', runId: 'run_c_00000003', status: 'aborted', taskProfile: ['code-gen'], contestants: ['a/x', 'b/y'], forfeits: [{ model: 'a/x', kind: 'no_contest', reason: 'down' }] },
    ])
    const d = buildBoardData(dir, catalog, state, { repo: 'test-repo' })
    expect(d.bouts).toHaveLength(2) // aborted excluded from bout cards
    expect(d.bouts[0]!.runId).toBe('run_b_00000002') // newest first
    const t = d.bouts[1]!
    expect(t.outcome).toBe('reworked')
    expect(t.learning).toBe('missed an edge case')
    expect(t.ranking.find((r) => r.model === 'a/x')?.delta).toBe(16)
    expect(d.counters).toMatchObject({ runs: 3, tournaments: 2, singles: 1, aborted: 1, requests: 6, promptTokens: 1500, completionTokens: 300 })
    expect(d.counters.sonnetEquivUsd).toBeCloseTo(1500 / 1e6 * 3 + 300 / 1e6 * 15, 4)
    expect(d.corruptLines).toBe(1)
    expect(d.record).toEqual({ accepted: 0, reworked: 1, rejected: 0 })
    expect(d.ladders.find((l) => l.tag === 'code-gen')!.rows[0]).toMatchObject({ rank: 1, id: 'a/x', elo: 1016 })
    expect(d.scouting[0]).toMatchObject({ model: 'a/x', note: 'fabricates when under-reading' })
    expect(d.judgeAgreement).toEqual({ agree: 1, total: 2 })
    expect(d.repo).toBe('test-repo')
  })

  it('handles a missing runs dir and days filter', () => {
    const empty = buildBoardData('/nonexistent/nowhere', catalog, state)
    expect(empty.bouts).toEqual([])
    expect(empty.counters.runs).toBe(0)
    const dir = writeTraces([tournament])
    const filtered = buildBoardData(dir, catalog, state, { days: 0 })
    expect(filtered.bouts).toEqual([]) // ts older than a 0-day window
    expect(filtered.counters.runs).toBe(1) // counters stay all-time
  })

  it('treats a delegate record missing runId as corrupt, not a real run', () => {
    const dir = writeTraces([
      { ts: '2026-07-03T02:00:00Z', kind: 'delegate', status: 'ok', taskProfile: ['code-gen'], workerModel: 'a/x', reviewerModel: 'b/y', requests: 1, promptTokens: 10, completionTokens: 5 },
      'this line is not json{{{',
    ])
    const d = buildBoardData(dir, catalog, state)
    expect(d.bouts).toHaveLength(0)
    expect(d.counters.runs).toBe(0)
    expect(d.corruptLines).toBe(2) // 1 genuinely-unparseable line + 1 record missing runId
  })

  it('treats a delegate record missing workerModel as corrupt, not a real run', () => {
    const dir = writeTraces([
      { ts: '2026-07-03T02:00:00Z', kind: 'delegate', runId: 'run_d_00000004', status: 'ok', taskProfile: ['code-gen'], reviewerModel: 'b/y', requests: 1, promptTokens: 10, completionTokens: 5 },
    ])
    const d = buildBoardData(dir, catalog, state)
    expect(d.bouts).toHaveLength(0)
    expect(d.counters.runs).toBe(0)
    expect(d.corruptLines).toBe(1)
  })
})
