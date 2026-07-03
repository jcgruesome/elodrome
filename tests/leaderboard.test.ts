import { describe, expect, it } from 'vitest'
import { buildLeaderboard, renderLeaderboardMd } from '../src/registry/leaderboard'
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
  models: {
    'a/x': { ratings: { 'code-gen': { elo: 1040.4, matches: 3 } }, outcomes: { accepted: 0, reworked: 0, rejected: 0 }, availabilityStrikes: 1 },
    'b/y': { ratings: { 'code-gen': { elo: 980, matches: 3 }, review: { elo: 1010, matches: 2 } }, outcomes: { accepted: 0, reworked: 0, rejected: 0 }, availabilityStrikes: 0 },
  },
}

describe('leaderboard', () => {
  it('builds ranked sections per tag', () => {
    const sections = buildLeaderboard(catalog, state)
    const codeGen = sections.find((s) => s.tag === 'code-gen')!
    expect(codeGen.rows.map((r) => r.id)).toEqual(['a/x', 'b/y'])
    expect(codeGen.rows[0]).toMatchObject({ rank: 1, elo: 1040.4, matches: 3, strikes: 1 })
    expect(sections.find((s) => s.tag === 'review')!.rows).toHaveLength(1)
  })

  it('filters by tag and skips unrated models', () => {
    const only = buildLeaderboard(catalog, state, 'review')
    expect(only).toHaveLength(1)
    expect(only[0]!.rows.map((r) => r.id)).toEqual(['b/y'])
  })

  it('renders markdown', () => {
    const md = renderLeaderboardMd(buildLeaderboard(catalog, state, 'code-gen'), 'my-repo leaderboard')
    expect(md).toContain('# my-repo leaderboard')
    expect(md).toContain('## code-gen')
    expect(md).toContain('| 1 | a/x | 1040 | 3 |')
  })
})
