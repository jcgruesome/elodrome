import { describe, expect, it } from 'vitest'
import { buildBriefing, decide, eligibleModels, selectJudges } from '../src/arena/select'
import type { Registry } from '../src/registry/schema'
import type { NvState } from '../src/registry/state'

const catalog: Registry = {
  version: 1,
  models: [
    { id: 'a/one', name: 'One', tags: ['code-gen', 'fast'], contextWindow: 1, toolCalling: 'reliable', outcomes: { accepted: 0, reworked: 0, rejected: 0 } },
    { id: 'b/two', name: 'Two', tags: ['code-gen'], contextWindow: 1, toolCalling: 'reliable', outcomes: { accepted: 0, reworked: 0, rejected: 0 } },
    { id: 'c/three', name: 'Three', tags: ['code-gen'], contextWindow: 1, toolCalling: 'reliable', outcomes: { accepted: 0, reworked: 0, rejected: 0 } },
    { id: 'd/judge', name: 'Judge', tags: ['review'], contextWindow: 1, toolCalling: 'none', outcomes: { accepted: 0, reworked: 0, rejected: 0 } },
    { id: 'e/flaky', name: 'Flaky', tags: ['code-gen'], contextWindow: 1, toolCalling: 'unreliable', outcomes: { accepted: 0, reworked: 0, rejected: 0 } },
  ],
}

function stateWith(ratings: Record<string, { elo: number; matches: number }>): NvState {
  return {
    version: 1,
    models: Object.fromEntries(Object.entries(ratings).map(([id, r]) => [id, {
      ratings: { 'code-gen': r, review: r },
      outcomes: { accepted: 0, reworked: 0, rejected: 0 },
      availabilityStrikes: 0,
      learnings: [],
    }])),
    judgeAgreement: { agree: 0, total: 0 },
  }
}

describe('selection', () => {
  it('eligibility requires all tags and reliable tools', () => {
    const ids = eligibleModels(catalog, ['code-gen']).map((m) => m.id)
    expect(ids).toEqual(['a/one', 'b/two', 'c/three'])
    expect(eligibleModels(catalog, ['code-gen', 'fast']).map((m) => m.id)).toEqual(['a/one'])
  })

  it('routes single when a dominant champion exists', () => {
    const state = stateWith({ 'a/one': { elo: 1200, matches: 6 }, 'b/two': { elo: 1050, matches: 4 } })
    const d = decide(catalog, state, ['code-gen'])
    expect(d).toEqual({ mode: 'single', model: expect.objectContaining({ id: 'a/one' }) })
  })

  it('runs a tournament when lead or matches are insufficient', () => {
    const lowMatches = stateWith({ 'a/one': { elo: 1300, matches: 4 }, 'b/two': { elo: 1000, matches: 0 } })
    expect(decide(catalog, lowMatches, ['code-gen']).mode).toBe('tournament')
    const lowLead = stateWith({ 'a/one': { elo: 1050, matches: 9 }, 'b/two': { elo: 1000, matches: 9 } })
    expect(decide(catalog, lowLead, ['code-gen']).mode).toBe('tournament')
  })

  it('picks top-2 plus the least-played explorer, deterministically', () => {
    const state = stateWith({
      'a/one': { elo: 1100, matches: 9 },
      'b/two': { elo: 1050, matches: 9 },
      'c/three': { elo: 900, matches: 1 },
    })
    const d = decide(catalog, state, ['code-gen'])
    expect(d.mode).toBe('tournament')
    if (d.mode === 'tournament') {
      expect(d.contestants.map((c) => c.id)).toEqual(['a/one', 'b/two', 'c/three'])
    }
  })

  it('throws on empty profile and thin catalogs', () => {
    const state = stateWith({})
    expect(() => decide(catalog, state, [])).toThrow(/at least one/)
    expect(() => decide(catalog, state, ['research'])).toThrow(/eligible/i)
  })

  it('selects judges by review elo excluding contestants, throws when none', () => {
    const state = stateWith({ 'd/judge': { elo: 1000, matches: 0 } })
    expect(selectJudges(catalog, state, ['a/one']).map((j) => j.id)).toEqual(['d/judge'])
    expect(() => selectJudges(catalog, state, ['d/judge'])).toThrow(/review/i)
  })
})

function stateWithLearnings(notes: Array<{ note: string; tags: string[]; ts: string }>): NvState {
  return {
    version: 1,
    judgeAgreement: { agree: 0, total: 0 },
    models: {
      'a/one': {
        ratings: {}, outcomes: { accepted: 0, reworked: 0, rejected: 0 },
        availabilityStrikes: 0,
        learnings: notes.map((n) => ({ ...n })),
      },
    },
  }
}

describe('buildBriefing', () => {
  it('returns latest 3 tag-eligible notes newest first, scrubbed', () => {
    const s = stateWithLearnings([
      { note: 'oldest code note', tags: ['code-gen'], ts: '1' },
      { note: 'research-only note', tags: ['research'], ts: '2' },
      { note: 'untagged note applies anywhere', tags: [], ts: '3' },
      { note: 'newer code note', tags: ['code-gen'], ts: '4' },
      { note: 'mentions a/one by name', tags: ['code-gen'], ts: '5' },
    ])
    const b = buildBriefing(s, 'a/one', ['code-gen'], ['a/one'])
    expect(b).toBeDefined()
    const lines = b!.split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe('- mentions [model] by name')
    expect(lines[1]).toBe('- newer code note')
    expect(lines[2]).toBe('- untagged note applies anywhere')
    expect(b).not.toContain('research-only')
  })

  it('returns undefined for no notes or no eligible notes', () => {
    expect(buildBriefing(stateWithLearnings([]), 'a/one', ['code-gen'], [])).toBeUndefined()
    const onlyResearch = stateWithLearnings([{ note: 'research-only note', tags: ['research'], ts: '1' }])
    expect(buildBriefing(onlyResearch, 'a/one', ['code-gen'], [])).toBeUndefined()
    expect(buildBriefing(onlyResearch, 'missing/model', ['code-gen'], [])).toBeUndefined()
  })
})
