import { describe, expect, it } from 'vitest'
import {
  addAvailabilityStrike, addLearning, applyOutcome, applyTournament, expectedScore,
  forgetLearnings, tournamentDeltas,
} from '../src/arena/elo'
import { getRating, LEARNING_CAP, type Learning, type NvState } from '../src/registry/state'

const empty: NvState = { version: 1, models: {}, judgeAgreement: { agree: 0, total: 0 } }

const note = (n: string, ts = '2026-07-03T00:00:00Z'): Learning => ({
  ts, note: n, tags: ['code-gen'], outcome: 'reworked', runId: 'run_x_00000000',
})

describe('elo math', () => {
  it('expected score is 0.5 for equals and sums to 1', () => {
    expect(expectedScore(1000, 1000)).toBe(0.5)
    expect(expectedScore(1100, 1000) + expectedScore(1000, 1100)).toBeCloseTo(1)
  })

  it('deltas are zero-sum and reward the winner', () => {
    const d = tournamentDeltas(
      [{ model: 'x', place: 1 }, { model: 'y', place: 2 }],
      () => 1000,
    )
    expect(d.x).toBe(16) // K=32 * (1 - 0.5)
    expect(d.y).toBe(-16)
  })

  it('no-contest entries contribute and receive nothing', () => {
    const d = tournamentDeltas(
      [{ model: 'x', place: 1 }, { model: 'y', place: 2 }, { model: 'z', place: null }],
      () => 1000,
    )
    expect(d.z).toBe(0)
    expect(d.x).toBe(16)
  })

  it('equal places (two loss-forfeits) skip each other', () => {
    const d = tournamentDeltas(
      [{ model: 'x', place: 1 }, { model: 'y', place: 2 }, { model: 'z', place: 2 }],
      () => 1000,
    )
    expect(d.y).toBe(-16)
    expect(d.z).toBe(-16)
    expect(d.x).toBe(32)
  })

  it('applyTournament updates elo and matches per profile tag, skipping no-contests', () => {
    const next = applyTournament(empty, ['code-gen', 'fast'], [
      { model: 'x', place: 1 }, { model: 'y', place: 2 }, { model: 'z', place: null },
    ])
    expect(getRating(next, 'x', 'code-gen')).toEqual({ elo: 1016, matches: 1 })
    expect(getRating(next, 'x', 'fast').matches).toBe(1)
    expect(getRating(next, 'z', 'code-gen')).toEqual({ elo: 1000, matches: 0 })
    expect(getRating(empty, 'x', 'code-gen').elo).toBe(1000) // immutability
  })

  it('applyOutcome counts once and nudges every tag', () => {
    const next = applyOutcome(empty, 'x', ['code-gen', 'fast'], 'rejected')
    expect(next.models.x?.outcomes.rejected).toBe(1)
    expect(getRating(next, 'x', 'code-gen').elo).toBe(984)
    expect(getRating(next, 'x', 'fast').elo).toBe(984)
  })

  it('addAvailabilityStrike increments', () => {
    const next = addAvailabilityStrike(addAvailabilityStrike(empty, 'x'), 'x')
    expect(next.models.x?.availabilityStrikes).toBe(2)
  })
})

describe('learnings', () => {
  it('appends and caps FIFO at LEARNING_CAP', () => {
    let s = empty
    for (let i = 0; i < LEARNING_CAP + 3; i++) s = addLearning(s, 'm', note(`note number ${i}`))
    const notes = s.models.m!.learnings.map((l) => l.note)
    expect(notes).toHaveLength(LEARNING_CAP)
    expect(notes[0]).toBe('note number 3') // oldest three dropped
    expect(notes.at(-1)).toBe(`note number ${LEARNING_CAP + 2}`)
    expect(empty.models.m).toBeUndefined() // immutability
  })

  it('dedupes byte-identical notes by refreshing to newest', () => {
    let s = addLearning(empty, 'm', note('same note text', '2026-01-01T00:00:00Z'))
    s = addLearning(s, 'm', note('another note here'))
    s = addLearning(s, 'm', note('same note text', '2026-07-03T09:00:00Z'))
    const ls = s.models.m!.learnings
    expect(ls).toHaveLength(2)
    expect(ls.at(-1)!.note).toBe('same note text')
    expect(ls.at(-1)!.ts).toBe('2026-07-03T09:00:00Z')
  })

  it('forgets by substring and ignores unknown models', () => {
    let s = addLearning(empty, 'm', note('fabricates citations under pressure'))
    s = addLearning(s, 'm', note('slow on long files'))
    s = forgetLearnings(s, 'm', 'fabricates')
    expect(s.models.m!.learnings.map((l) => l.note)).toEqual(['slow on long files'])
    expect(forgetLearnings(s, 'nope/nope', 'x')).toEqual(s)
  })
})
