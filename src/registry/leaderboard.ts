import type { Registry } from './schema'
import type { NvState } from './state'

export interface LeaderboardRow {
  rank: number
  id: string
  name: string
  elo: number
  matches: number
  strikes: number
}

export function buildLeaderboard(
  catalog: Registry,
  state: NvState,
  tag?: string,
): Array<{ tag: string; rows: LeaderboardRow[] }> {
  const tags = tag
    ? [tag]
    : [...new Set(catalog.models.flatMap((m) => m.tags))].sort()
  return tags
    .map((t) => {
      const rows = catalog.models
        .map((m) => ({ m, rating: state.models[m.id]?.ratings[t] }))
        .filter((x): x is { m: typeof x.m; rating: NonNullable<typeof x.rating> } => x.rating !== undefined)
        .sort((a, b) => b.rating.elo - a.rating.elo || a.m.id.localeCompare(b.m.id))
        .map((x, i) => ({
          rank: i + 1,
          id: x.m.id,
          name: x.m.name,
          elo: x.rating.elo,
          matches: x.rating.matches,
          strikes: state.models[x.m.id]?.availabilityStrikes ?? 0,
        }))
      return { tag: t, rows }
    })
    .filter((s) => s.rows.length > 0)
}

export function renderLeaderboardMd(
  sections: Array<{ tag: string; rows: LeaderboardRow[] }>,
  title: string,
  judgeAgreement?: { agree: number; total: number },
): string {
  const parts = [`# ${title}`, '']
  if (judgeAgreement && judgeAgreement.total > 0) {
    const pct = Math.round((judgeAgreement.agree / judgeAgreement.total) * 100)
    parts.push(`Judge agreement: ${pct}% (${judgeAgreement.agree}/${judgeAgreement.total} panels)`, '')
  }
  for (const s of sections) {
    parts.push(`## ${s.tag}`, '', '| # | model | Elo | matches |', '|---|---|---|---|')
    for (const r of s.rows) parts.push(`| ${r.rank} | ${r.id} | ${Math.round(r.elo)} | ${r.matches} |`)
    parts.push('')
  }
  return parts.join('\n')
}
