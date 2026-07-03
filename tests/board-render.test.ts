import { describe, expect, it } from 'vitest'
import { renderBoardHtml } from '../src/board/render'
import type { BoardData, Bout } from '../src/board/data'

const data: BoardData = {
  generatedAt: '2026-07-03T05:00:00Z',
  repo: 'test-repo',
  bouts: [{
    runId: 'run_a_00000001', ts: '2026-07-03T02:00:00Z', mode: 'tournament', status: 'ok',
    taskProfile: ['code-gen'], workerModel: 'a/x', judges: ['b/y'], agreement: false, revised: false,
    ranking: [
      { model: 'a/x', place: 1, delta: 16 },
      { model: 'b/y', place: 2, delta: -16 },
      { model: 'c/z', place: null, forfeit: 'no_contest', forfeitReason: 'HTTP 503 <down>' },
    ],
    requests: 4, promptTokens: 1000, completionTokens: 200,
    outcome: 'rejected', learning: 'fabricated <script>alert(1)</script> citations',
  }],
  counters: { runs: 3, tournaments: 2, singles: 1, aborted: 1, requests: 6, promptTokens: 1500, completionTokens: 300, sonnetEquivUsd: 0.01, opusEquivUsd: 0.05 },
  ladders: [{ tag: 'code-gen', rows: [{ rank: 1, id: 'a/x', elo: 1016.4, matches: 2 }] }],
  record: { accepted: 1, reworked: 2, rejected: 1 },
  scouting: [{ model: 'a/x', note: 'reads too little before writing', ts: '2026-07-03T01:00:00Z' }],
  judgeAgreement: { agree: 1, total: 2 },
  corruptLines: 1,
}

describe('renderBoardHtml', () => {
  const html = renderBoardHtml(data)

  it('is a self-contained ReshapeX-tokened page', () => {
    expect(html.startsWith('<title>NV-AGENTS ARENA')).toBe(true)
    expect(html).toContain('ReshapeX app-ui tokens — DS bundle snapshot 2026-07-03')
    for (const v of ['#0D1117', '#1C2128', '#73B400', '#FF006E', 'Plus Jakarta Sans', 'JetBrains Mono']) {
      expect(html).toContain(v)
    }
    expect(html).toContain('prefers-color-scheme: light')
    expect(html).toContain('[data-theme="dark"]')
    expect(html).toContain('[data-theme="light"]')
    expect(html).not.toContain('http://')
    expect(html).not.toContain('https://')
  })

  it('renders bouts with DQ styling, deltas, forfeits, and escaped text', () => {
    expect(html).toContain('class="bout inquiry"')
    expect(html).toContain("Stewards' inquiry")
    expect(html).toContain('+16')
    expect(html).toContain('−16')
    expect(html).toContain('no_contest')
    expect(html).toContain('HTTP 503 &lt;down&gt;')
    expect(html).toContain('fabricated &lt;script&gt;alert(1)&lt;/script&gt; citations')
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('Split')
  })

  it('renders counters, ladders, scouting, record, and footer diagnostics', () => {
    expect(html).toContain('1,500')          // formatted prompt tokens
    expect(html).toContain('$0.01')
    expect(html).toContain('$0.05')
    expect(html).toContain('$0.00')
    expect(html).toContain('1016')          // ladder elo rounded
    expect(html).toContain('reads too little before writing')
    expect(html).toContain('1 accepted')
    expect(html).toContain('2 reworked')
    expect(html).toContain('1 rejected')
    expect(html).toContain('50% (1/2 panels)')
    expect(html).toContain('1 corrupt trace line')
  })
})

describe('renderBoardHtml — untrusted trace data', () => {
  // mode and outcome are closed TS union types on Bout, but that guarantee is
  // compile-time only: both values actually originate from JSON.parse() on
  // trace JSONL files read from disk, so a corrupted/tampered trace line can
  // put arbitrary text into either field. Simulate that by bypassing the type
  // system the same way untrusted disk data would.
  const maliciousBout = {
    ...data.bouts[0],
    mode: '<script>alert(1)</script>',
    outcome: '<script>alert(1)</script>',
  } as unknown as Bout
  const maliciousData: BoardData = { ...data, bouts: [maliciousBout] }
  const html = renderBoardHtml(maliciousData)

  it('escapes an untrusted bout.mode instead of interpolating it raw', () => {
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('escapes an untrusted bout.outcome in both the class name and visible text', () => {
    expect(html).not.toContain('<span class="badge outcome-<script>alert(1)</script>">')
    expect(html).toContain('outcome-&lt;script&gt;alert(1)&lt;/script&gt;')
  })
})
