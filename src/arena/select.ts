import { scrubModelNames } from './judge'
import type { CapabilityTag, ModelEntry, Registry } from '../registry/schema'
import { getRating, type NvState } from '../registry/state'

export const GATE_MIN_MATCHES = 5
export const GATE_MIN_LEAD = 100

export type GateDecision =
  | { mode: 'single'; model: ModelEntry }
  | { mode: 'tournament'; contestants: ModelEntry[] }

export function eligibleModels(catalog: Registry, profile: CapabilityTag[]): ModelEntry[] {
  return catalog.models.filter(
    (m) => profile.every((t) => m.tags.includes(t)) && m.toolCalling === 'reliable',
  )
}

function byEloDesc(state: NvState, tag: string) {
  return (a: ModelEntry, b: ModelEntry) =>
    getRating(state, b.id, tag).elo - getRating(state, a.id, tag).elo || a.id.localeCompare(b.id)
}

export function decide(catalog: Registry, state: NvState, profile: CapabilityTag[]): GateDecision {
  if (profile.length === 0) {
    throw new Error('task_profile must contain at least one capability tag for arena routing')
  }
  const primary = profile[0]!
  const eligible = [...eligibleModels(catalog, profile)].sort(byEloDesc(state, primary))
  if (eligible.length < 2) {
    throw new Error(
      `Arena needs at least 2 eligible models for profile [${profile.join(',')}] `
      + `(all tags + reliable tool calling); found ${eligible.length}. `
      + 'Pass an explicit model to bypass the arena.',
    )
  }
  const champion = getRating(state, eligible[0]!.id, primary)
  const runnerUp = getRating(state, eligible[1]!.id, primary)
  if (champion.matches >= GATE_MIN_MATCHES && champion.elo - runnerUp.elo >= GATE_MIN_LEAD) {
    return { mode: 'single', model: eligible[0]! }
  }
  const rest = eligible.slice(2)
  const explorer = [...rest].sort(
    (a, b) => getRating(state, a.id, primary).matches - getRating(state, b.id, primary).matches
      || a.id.localeCompare(b.id),
  )[0]
  return {
    mode: 'tournament',
    contestants: explorer ? [eligible[0]!, eligible[1]!, explorer] : [eligible[0]!, eligible[1]!],
  }
}

export function selectJudges(catalog: Registry, state: NvState, excludeIds: string[]): ModelEntry[] {
  const judges = catalog.models
    .filter((m) => m.tags.includes('review') && !excludeIds.includes(m.id))
    .sort(byEloDesc(state, 'review'))
    .slice(0, 2)
  if (judges.length === 0) {
    throw new Error('No review-tagged models available to judge (all are contestants or none exist)')
  }
  return judges
}

const BRIEFING_NOTES = 3

export function buildBriefing(
  state: NvState,
  modelId: string,
  profile: CapabilityTag[],
  scrubNames: string[],
): string | undefined {
  const learnings = state.models[modelId]?.learnings ?? []
  const eligible = learnings.filter(
    (l) => l.tags.length === 0 || l.tags.some((t) => (profile as string[]).includes(t)),
  )
  if (eligible.length === 0) return undefined
  return eligible
    .slice(-BRIEFING_NOTES)
    .reverse()
    .map((l) => `- ${scrubModelNames(l.note, scrubNames)}`)
    .join('\n')
}
