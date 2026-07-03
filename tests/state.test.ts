import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Registry } from '../src/registry/schema'
import {
  defaultStatePath, getRating, loadState, saveState, withStateLock,
} from '../src/registry/state'

const catalog: Registry = {
  version: 1,
  models: [
    { id: 'a/fresh', name: 'Fresh', tags: ['code-gen'], contextWindow: 1, toolCalling: 'reliable', outcomes: { accepted: 0, reworked: 0, rejected: 0 } },
    { id: 'b/veteran', name: 'Vet', tags: ['code-gen', 'review'], contextWindow: 1, toolCalling: 'reliable', outcomes: { accepted: 3, reworked: 1, rejected: 1 } },
  ],
}

function tmpState(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'state-')), 'state.json')
}

describe('state store', () => {
  it('resolves the default path with env override', () => {
    expect(defaultStatePath({ NVAGENTS_STATE: '/x/s.json' })).toBe('/x/s.json')
    expect(defaultStatePath({})).toMatch(/\.nv-agents\/state\.json$/)
  })

  it('creates and seeds from catalog legacy outcomes', () => {
    const state = loadState(tmpState(), catalog)
    expect(getRating(state, 'a/fresh', 'code-gen')).toEqual({ elo: 1000, matches: 0 })
    // 1000 + 8*3 - 4*1 - 16*1 = 1004, matches = 5, on every tag
    expect(getRating(state, 'b/veteran', 'code-gen')).toEqual({ elo: 1004, matches: 5 })
    expect(getRating(state, 'b/veteran', 'review')).toEqual({ elo: 1004, matches: 5 })
    expect(state.models['b/veteran']?.outcomes.accepted).toBe(3)
  })

  it('round-trips through save/load and re-seeds new catalog models only', () => {
    const p = tmpState()
    const state = loadState(p, catalog)
    saveState(p, state)
    const bigger: Registry = { ...catalog, models: [...catalog.models, { id: 'c/new', name: 'N', tags: ['fast'], contextWindow: 1, toolCalling: 'none', outcomes: { accepted: 0, reworked: 0, rejected: 0 } }] }
    const reloaded = loadState(p, bigger)
    expect(reloaded.models['c/new']).toBeDefined()
    expect(getRating(reloaded, 'b/veteran', 'review').elo).toBe(1004)
  })

  it('throws on malformed state files', () => {
    const p = tmpState()
    fs.writeFileSync(p, '{"version":9}')
    expect(() => loadState(p, catalog)).toThrow()
  })

  it('serializes concurrent writers so no update is lost', async () => {
    const p = tmpState()
    await Promise.all(Array.from({ length: 5 }, () =>
      withStateLock(p, catalog, (s) => ({
        state: {
          ...s,
          models: {
            ...s.models,
            'a/fresh': { ...s.models['a/fresh']!, availabilityStrikes: s.models['a/fresh']!.availabilityStrikes + 1 },
          },
        },
        result: null,
      }))))
    expect(loadState(p, catalog).models['a/fresh']?.availabilityStrikes).toBe(5)
  })

  it('recovers a stale lock', async () => {
    const p = tmpState()
    fs.mkdirSync(`${p}.lock`, { recursive: true })
    const old = Date.now() / 1000 - 60
    fs.utimesSync(`${p}.lock`, old, old)
    const result = await withStateLock(p, catalog, (s) => ({ state: s, result: 'ok' }))
    expect(result).toBe('ok')
  })
})
