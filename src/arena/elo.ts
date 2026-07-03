import type { CapabilityTag } from '../registry/schema'
import { getRating, type ModelState, type NvState, type TagRating } from '../registry/state'

export const K_FACTOR = 32
export const OUTCOME_NUDGE = { accepted: 8, reworked: -4, rejected: -16 } as const
export type Outcome = keyof typeof OUTCOME_NUDGE

export interface TournamentResult {
  model: string
  /** 1 = best. null = no-contest (infra forfeit): excluded from all pairs. */
  place: number | null
}

export function expectedScore(a: number, b: number): number {
  return 1 / (1 + 10 ** ((b - a) / 400))
}

export function tournamentDeltas(
  results: TournamentResult[],
  eloOf: (model: string) => number,
): Record<string, number> {
  const deltas: Record<string, number> = Object.fromEntries(results.map((r) => [r.model, 0]))
  for (let i = 0; i < results.length; i++) {
    for (let j = i + 1; j < results.length; j++) {
      const a = results[i]!
      const b = results[j]!
      if (a.place === null || b.place === null || a.place === b.place) continue
      const scoreA = a.place < b.place ? 1 : 0
      const d = K_FACTOR * (scoreA - expectedScore(eloOf(a.model), eloOf(b.model)))
      deltas[a.model]! += d
      deltas[b.model]! -= d
    }
  }
  return deltas
}

const EMPTY_MODEL: ModelState = {
  ratings: {},
  outcomes: { accepted: 0, reworked: 0, rejected: 0 },
  availabilityStrikes: 0,
}

function withModel(state: NvState, modelId: string, f: (m: ModelState) => ModelState): NvState {
  const current = state.models[modelId] ?? EMPTY_MODEL
  return { ...state, models: { ...state.models, [modelId]: f(current) } }
}

function withRating(state: NvState, modelId: string, tag: string, rating: TagRating): NvState {
  return withModel(state, modelId, (m) => ({ ...m, ratings: { ...m.ratings, [tag]: rating } }))
}

export function applyTournament(
  state: NvState,
  profile: CapabilityTag[],
  results: TournamentResult[],
): NvState {
  let next = state
  for (const tag of profile) {
    const deltas = tournamentDeltas(results, (m) => getRating(next, m, tag).elo)
    for (const r of results) {
      if (r.place === null) continue
      const rating = getRating(next, r.model, tag)
      next = withRating(next, r.model, tag, {
        elo: rating.elo + (deltas[r.model] ?? 0),
        matches: rating.matches + 1,
      })
    }
  }
  return next
}

export function applyOutcome(
  state: NvState,
  modelId: string,
  tags: CapabilityTag[],
  outcome: Outcome,
): NvState {
  let next = withModel(state, modelId, (m) => ({
    ...m,
    outcomes: { ...m.outcomes, [outcome]: m.outcomes[outcome] + 1 },
  }))
  for (const tag of tags) {
    const rating = getRating(next, modelId, tag)
    next = withRating(next, modelId, tag, { ...rating, elo: rating.elo + OUTCOME_NUDGE[outcome] })
  }
  return next
}

export function addAvailabilityStrike(state: NvState, modelId: string): NvState {
  return withModel(state, modelId, (m) => ({ ...m, availabilityStrikes: m.availabilityStrikes + 1 }))
}
