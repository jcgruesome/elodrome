import { describe, expect, it } from 'vitest'
import {
  addAvailabilityStrike, applyOutcome, applyTournament, expectedScore, tournamentDeltas,
} from '../src/arena/elo'
import { getRating, type NvState } from '../src/registry/state'

const empty: NvState = { version: 1, models: {}, judgeAgreement: { agree: 0, total: 0 } }

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
