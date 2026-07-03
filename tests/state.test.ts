import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Registry } from '../src/registry/schema'
import {
  defaultStatePath, getRating, loadState, saveState, withStateLock,
} from '../src/registry/state'

const fixturePath = fileURLToPath(new URL('./fixtures/lock-stress.mts', import.meta.url))

function runStressChild(statePath: string, iterations: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', fixturePath, statePath, String(iterations)],
      { stdio: 'inherit' },
    )
    child.on('error', reject)
    child.on('exit', (code) => resolve(code ?? -1))
  })
}

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
    expect(defaultStatePath({ ELODROME_STATE: '/x/s.json' })).toBe('/x/s.json')
    expect(defaultStatePath({})).toMatch(/\.elodrome\/state\.json$/)
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

  it('parses judgeAgreement and defaults it when absent', () => {
    const p = tmpState()
    saveState(p, { version: 1, models: {}, judgeAgreement: { agree: 3, total: 5 } })
    const withValue = loadState(p, catalog)
    expect(withValue.judgeAgreement).toEqual({ agree: 3, total: 5 })

    const p2 = tmpState()
    fs.writeFileSync(p2, JSON.stringify({ version: 1, models: {} }))
    const withDefault = loadState(p2, catalog)
    expect(withDefault.judgeAgreement).toEqual({ agree: 0, total: 0 })
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

  it('blocks while the lock is held', async () => {
    const p = tmpState()
    const lockDir = `${p}.lock`
    fs.mkdirSync(lockDir)
    let ran = false
    const promise = withStateLock(p, catalog, (s) => {
      ran = true
      return { state: s, result: 'done' }
    })
    await new Promise((r) => setTimeout(r, 150))
    expect(ran).toBe(false)
    fs.rmdirSync(lockDir)
    const result = await promise
    expect(ran).toBe(true)
    expect(result).toBe('done')
  })

  it('sequential waiters both apply their update', async () => {
    const p = tmpState()
    const lockDir = `${p}.lock`
    fs.mkdirSync(lockDir, { recursive: true })
    const old = Date.now() / 1000 - 60
    fs.utimesSync(lockDir, old, old)

    const bump = () => withStateLock(p, catalog, (s) => ({
      state: {
        ...s,
        models: {
          ...s.models,
          'a/fresh': { ...s.models['a/fresh']!, availabilityStrikes: s.models['a/fresh']!.availabilityStrikes + 1 },
        },
      },
      result: null,
    }))

    await Promise.all([bump(), bump()])

    expect(loadState(p, catalog).models['a/fresh']?.availabilityStrikes).toBe(2)
    const dir = path.dirname(p)
    const leftovers = fs.readdirSync(dir).filter((name) => name.includes('.lock') || name.includes('.reclaim-'))
    expect(leftovers).toEqual([])
  })

  it('cross-process contention loses no updates', async () => {
    const p = tmpState()
    const [codeA, codeB] = await Promise.all([
      runStressChild(p, 25),
      runStressChild(p, 25),
    ])
    expect(codeA).toBe(0)
    expect(codeB).toBe(0)

    const state = loadState(p, catalog)
    expect(state.models['stress/model']?.availabilityStrikes).toBe(50)

    const dir = path.dirname(p)
    const leftovers = fs.readdirSync(dir).filter((name) => name.includes('.lock') || name.includes('.reclaim-'))
    expect(leftovers).toEqual([])
  }, 30_000)

  it('round-trips learnings through save/load', () => {
    const p = tmpState()
    const s0 = loadState(p, catalog)
    const withNote = {
      ...s0,
      models: {
        ...s0.models,
        'a/fresh': {
          ...s0.models['a/fresh']!,
          learnings: [{ ts: '2026-07-03T00:00:00Z', note: 'a good learning note', tags: ['code-gen'] }],
        },
      },
    }
    saveState(p, withNote)
    expect(loadState(p, catalog).models['a/fresh']?.learnings[0]?.note).toBe('a good learning note')
  })

  it('cross-process contention reclaims a pre-existing stale lock without losing updates', async () => {
    const p = tmpState()
    const lockDir = `${p}.lock`
    fs.mkdirSync(lockDir, { recursive: true })
    const old = Date.now() / 1000 - 60
    fs.utimesSync(lockDir, old, old)

    const [codeA, codeB] = await Promise.all([
      runStressChild(p, 25),
      runStressChild(p, 25),
    ])
    expect(codeA).toBe(0)
    expect(codeB).toBe(0)

    const state = loadState(p, catalog)
    expect(state.models['stress/model']?.availabilityStrikes).toBe(50)

    const dir = path.dirname(p)
    const leftovers = fs.readdirSync(dir).filter((name) => name.includes('.lock') || name.includes('.reclaim-'))
    expect(leftovers).toEqual([])
  }, 30_000)
})
