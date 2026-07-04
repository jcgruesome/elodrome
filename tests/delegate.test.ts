import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config'
import { NimError, type ChatResult } from '../src/nim/client'
import { delegate } from '../src/pipeline/delegate'
import { getRating, loadState, saveState } from '../src/registry/state'
import type { Registry } from '../src/registry/schema'

const catalog: Registry = {
  version: 1,
  models: [
    { id: 'w/coder', name: 'W', tags: ['code-gen'], contextWindow: 1, toolCalling: 'reliable', outcomes: { accepted: 0, reworked: 0, rejected: 0 } },
    { id: 'w/coder2', name: 'W2', tags: ['code-gen'], contextWindow: 1, toolCalling: 'reliable', outcomes: { accepted: 0, reworked: 0, rejected: 0 } },
    { id: 'w/coder3', name: 'W3', tags: ['code-gen'], contextWindow: 1, toolCalling: 'reliable', outcomes: { accepted: 0, reworked: 0, rejected: 0 } },
    { id: 'r/rev', name: 'R', tags: ['review'], contextWindow: 1, toolCalling: 'none', outcomes: { accepted: 0, reworked: 0, rejected: 0 } },
  ],
}

let workspace: string
let statePath: string
let cfg: ReturnType<typeof loadConfig>

function plantState(path_: string, ratings: Record<string, { elo: number; matches: number }>) {
  saveState(path_, {
    version: 1,
    models: Object.fromEntries(Object.entries(ratings).map(([id, r]) => [id, {
      ratings: { 'code-gen': r, review: r },
      outcomes: { accepted: 0, reworked: 0, rejected: 0 },
      availabilityStrikes: 0,
      learnings: [],
    }])),
    judgeAgreement: { agree: 0, total: 0 },
  })
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-'))
  fs.writeFileSync(path.join(workspace, 'a.ts'), 'export const a = 1\n')
  cfg = loadConfig({ NVIDIA_API_KEY: 'k', ELODROME_RUNS_DIR: path.join(workspace, '.runs') })
  statePath = path.join(workspace, 'state.json')
  // Dominant champion so the six v1 behavioral tests exercise the single path unchanged.
  plantState(statePath, {
    'w/coder': { elo: 1200, matches: 9 },
    'w/coder2': { elo: 1000, matches: 9 },
    'w/coder3': { elo: 990, matches: 9 },
  })
})

function reply(partial: Partial<ChatResult>): ChatResult {
  return {
    content: null, toolCalls: [],
    assistantMessage: { role: 'assistant', content: partial.content ?? null },
    usage: { promptTokens: 1, completionTokens: 1 }, ...partial,
  }
}

const submit = (summary: string) => reply({
  toolCalls: [{
    id: 's', name: 'submit_result',
    arguments: JSON.stringify({ summary, rationale: 'r', changes: [{ path: 'a.ts', type: 'full', content: 'export const a = 2\n' }] }),
  }],
})
const pass = reply({ content: '{"verdict":"pass","issues":[]}' })
const fail = reply({ content: '{"verdict":"fail","issues":["bug: off by one"]}' })

describe('single mode — self-verification', () => {
  function makeGitWorkspace(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-verify-'))
    execFileSync('git', ['init', '-q'], { cwd: dir })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1\n')
    return dir
  }

  function commitAll(dir: string, message: string): void {
    execFileSync('git', ['add', '.'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '-m', message], { cwd: dir })
  }

  it('passes verification and reports status ok when the configured check succeeds', async () => {
    const gitWorkspace = makeGitWorkspace()
    fs.writeFileSync(path.join(gitWorkspace, 'elodrome.verify.json'), '{"ok": "exit 0"}')
    commitAll(gitWorkspace, 'init')
    const client = {
      chat: (() => {
        const queue = [submit('done'), reply({ content: '{"verdict":"pass","issues":[]}' })]
        return async () => queue.shift()!
      })(),
    }
    const result = await delegate(
      { config: cfg, catalog, statePath, client, launchDir: gitWorkspace },
      { task: 'do it', workspace: gitWorkspace, taskProfile: ['code-gen'], model: 'w/coder' },
    )
    expect(result.status).toBe('ok')
    expect(result.verify.status).toBe('passed')
  })

  it('feeds a failing check back to the worker for one revision, then succeeds', async () => {
    const gitWorkspace = makeGitWorkspace()
    fs.writeFileSync(path.join(gitWorkspace, 'elodrome.verify.json'), '{"check": "test -f fixed.txt"}')
    commitAll(gitWorkspace, 'init')
    const submitWithFix = reply({
      toolCalls: [{
        id: 's2',
        name: 'submit_result',
        arguments: JSON.stringify({
          summary: 'fixed', rationale: 'r',
          changes: [{ path: 'fixed.txt', type: 'full', content: 'x' }],
        }),
      }],
    })
    const client = {
      chat: (() => {
        const queue = [submit('first try'), submitWithFix, reply({ content: '{"verdict":"pass","issues":[]}' })]
        return async () => queue.shift()!
      })(),
    }
    const result = await delegate(
      { config: cfg, catalog, statePath, client, launchDir: gitWorkspace },
      { task: 'do it', workspace: gitWorkspace, taskProfile: ['code-gen'], model: 'w/coder' },
    )
    expect(result.status).toBe('ok')
    expect(result.revised).toBe(true)
    expect(result.verify.status).toBe('passed')
  })

  it('marks failed_review when verification still fails after the one revision attempt', async () => {
    const gitWorkspace = makeGitWorkspace()
    fs.writeFileSync(path.join(gitWorkspace, 'elodrome.verify.json'), '{"check": "exit 1"}')
    commitAll(gitWorkspace, 'init')
    const client = {
      chat: (() => {
        const queue = [submit('first try'), submit('second try')]
        return async () => queue.shift()!
      })(),
    }
    const result = await delegate(
      { config: cfg, catalog, statePath, client, launchDir: gitWorkspace },
      { task: 'do it', workspace: gitWorkspace, taskProfile: ['code-gen'], model: 'w/coder' },
    )
    expect(result.status).toBe('failed_review')
    expect(result.verify.status).toBe('failed')
  })

  it('skips verification for a non-git workspace, matching pre-existing behavior', async () => {
    const client = {
      chat: (() => {
        const queue = [submit('done'), reply({ content: '{"verdict":"pass","issues":[]}' })]
        return async () => queue.shift()!
      })(),
    }
    const result = await delegate(
      { config: cfg, catalog, statePath, client, launchDir: workspace },
      { task: 'do it', workspace, taskProfile: ['code-gen'], model: 'w/coder' },
    )
    expect(result.verify.status).toBe('skipped')
  })
})

function scripted(replies: ChatResult[]) {
  let i = 0
  const calls: string[] = []
  return {
    calls,
    chat: async (p: { model: string }) => {
      calls.push(p.model)
      const r = replies[i]; i += 1
      if (!r) throw new Error('exhausted')
      return r
    },
  }
}

type QueueItem = ChatResult | Error | ((prompt: string) => ChatResult)

/** Routes chat calls by model id; each model consumes its own reply queue. */
function routedByModel(queues: Record<string, QueueItem[]>) {
  const state = Object.fromEntries(Object.entries(queues).map(([k, v]) => [k, [...v]]))
  return {
    chat: async ({ model: m, messages }: { model: string; messages: Array<{ role: string; content: string | null }> }) => {
      const q = state[m]
      if (!q || q.length === 0) throw new Error(`no scripted reply for ${m}`)
      const next = q.shift()!
      if (next instanceof Error) throw next
      if (typeof next === 'function') {
        const lastUser = [...messages].reverse().find((msg) => msg.role === 'user')
        return next(lastUser?.content ?? '')
      }
      return next
    },
  }
}

const verdictOfLabels = (prompt: string): ChatResult => {
  const labels = [...prompt.matchAll(/## Entry ([A-E])/g)].map((m) => m[1]!)
  return reply({ content: JSON.stringify({ ranking: labels, verdicts: Object.fromEntries(labels.map((l) => [l, 'pass'])), issues: {} }) })
}

describe('delegate', () => {
  it('runs work -> critique -> ok without revision', async () => {
    const client = scripted([submit('v1'), pass])
    const res = await delegate(
      { config: cfg, catalog, statePath, client, launchDir: workspace },
      { task: 't', workspace, taskProfile: ['code-gen'] },
    )
    expect(res.status).toBe('ok')
    expect(res.revised).toBe(false)
    expect(res.mode).toBe('single')
    expect(res.workerModel).toBe('w/coder')
    expect(res.reviewerModel).toBe('r/rev')
    expect(client.calls).toEqual(['w/coder', 'r/rev'])
    expect(res.changes[0]?.valid).toBe(true)
    expect(fs.readdirSync(path.join(workspace, '.runs'))).toHaveLength(1)
    expect(res.stats.requests).toBe(2)
    expect(res.statsBreakdown.worker.requests).toBe(1)
    expect(res.statsBreakdown.reviewer.requests).toBe(1)
    expect(res.statsBreakdown.contestants).toBeUndefined()
  })

  it('revises once after a failed critique', async () => {
    const client = scripted([submit('v1'), fail, submit('v2'), pass])
    const res = await delegate(
      { config: cfg, catalog, statePath, client, launchDir: workspace },
      { task: 't', workspace, taskProfile: ['code-gen'] },
    )
    expect(res.status).toBe('ok')
    expect(res.revised).toBe(true)
    expect(res.summary).toBe('v2')
  })

  it('returns failed_review when critique still fails', async () => {
    const client = scripted([submit('v1'), fail, submit('v2'), fail])
    const res = await delegate(
      { config: cfg, catalog, statePath, client, launchDir: workspace },
      { task: 't', workspace, taskProfile: ['code-gen'] },
    )
    expect(res.status).toBe('failed_review')
    expect(res.critique.issues).toContain('bug: off by one')
  })

  it('revises once when critique passes but a change is invalid', async () => {
    const invalidSubmit = reply({
      toolCalls: [{
        id: 's', name: 'submit_result',
        arguments: JSON.stringify({
          summary: 'v1',
          rationale: 'r',
          changes: [{ path: 'missing.txt', type: 'diff', content: '--- a/missing.txt\n+++ b/missing.txt\n@@ -1 +1 @@\n-old\n+new\n' }],
        }),
      }],
    })
    const client = scripted([invalidSubmit, pass, submit('v2'), pass])
    const res = await delegate(
      { config: cfg, catalog, statePath, client, launchDir: workspace },
      { task: 't', workspace, taskProfile: ['code-gen'] },
    )
    expect(res.revised).toBe(true)
    expect(res.status).toBe('ok')
  })

  it('rejects an explicit model without reliable tool calling', async () => {
    const client = scripted([])
    await expect(delegate(
      { config: cfg, catalog, statePath, client, launchDir: workspace },
      { task: 't', workspace, taskProfile: [], model: 'r/rev' },
    )).rejects.toThrow(/tool calling/i)
  })

  it('rejects a workspace outside the launch dir', async () => {
    const client = scripted([])
    await expect(delegate(
      { config: cfg, catalog, statePath, client, launchDir: workspace },
      { task: 't', workspace: os.homedir(), taskProfile: ['code-gen'] },
    )).rejects.toThrow(/outside/i)
  })

  it('routes tournament when no dominant champion and updates elo', async () => {
    // catalog: w/coder, w/coder2, w/coder3 (code-gen, reliable) + r/rev (review, none)
    plantState(statePath, {
      'w/coder': { elo: 1010, matches: 2 }, 'w/coder2': { elo: 1000, matches: 2 }, 'w/coder3': { elo: 990, matches: 0 },
    })
    // 3 submits + 1 judge ranking (single judge in catalog)
    const client = routedByModel({
      'w/coder': [submit('c1')], 'w/coder2': [submit('c2')], 'w/coder3': [submit('c3')],
      'r/rev': [verdictOfLabels], // helper: builds ranking from whatever labels the prompt contained
    })
    const res = await delegate(
      { config: cfg, catalog, statePath, client, launchDir: workspace },
      { task: 't', workspace, taskProfile: ['code-gen'] },
    )
    expect(res.mode).toBe('tournament')
    expect(res.arena?.contestants).toHaveLength(3)
    expect(res.arena?.judges).toEqual(['r/rev'])
    const state = loadState(statePath, catalog)
    const winnerElo = getRating(state, res.workerModel, 'code-gen').elo
    expect(winnerElo).toBeGreaterThan(1010 - 1) // winner gained
    expect(res.arena?.eloDeltas[res.workerModel]).toBeGreaterThan(0)
    const contestants = res.statsBreakdown.contestants!
    expect(Object.keys(contestants)).toHaveLength(3)
    for (const s of Object.values(contestants)) expect(s.requests).toBeGreaterThanOrEqual(1)
  })

  it('records judge agreement in state for a tournament with 2 judges', async () => {
    const twoJudgeCatalog: Registry = {
      version: 1,
      models: [
        { id: 'w/coder', name: 'W', tags: ['code-gen'], contextWindow: 1, toolCalling: 'reliable', outcomes: { accepted: 0, reworked: 0, rejected: 0 } },
        { id: 'w/coder2', name: 'W2', tags: ['code-gen'], contextWindow: 1, toolCalling: 'reliable', outcomes: { accepted: 0, reworked: 0, rejected: 0 } },
        { id: 'r/rev', name: 'R', tags: ['review'], contextWindow: 1, toolCalling: 'none', outcomes: { accepted: 0, reworked: 0, rejected: 0 } },
        { id: 'r/rev2', name: 'R2', tags: ['review'], contextWindow: 1, toolCalling: 'none', outcomes: { accepted: 0, reworked: 0, rejected: 0 } },
      ],
    }
    plantState(statePath, { 'w/coder': { elo: 1000, matches: 0 }, 'w/coder2': { elo: 1000, matches: 0 } })
    const client = routedByModel({
      'w/coder': [submit('c1')], 'w/coder2': [submit('c2')],
      'r/rev': [verdictOfLabels], 'r/rev2': [verdictOfLabels],
    })
    const res = await delegate(
      { config: cfg, catalog: twoJudgeCatalog, statePath, client, launchDir: workspace },
      { task: 't', workspace, taskProfile: ['code-gen'] },
    )
    expect(res.mode).toBe('tournament')
    expect(res.arena?.judges).toHaveLength(2)
    const state = loadState(statePath, twoJudgeCatalog)
    expect(state.judgeAgreement.total).toBe(1)
  })

  it('single mode when champion dominates', async () => {
    plantState(statePath, { 'w/coder': { elo: 1200, matches: 9 }, 'w/coder2': { elo: 1000, matches: 9 }, 'w/coder3': { elo: 990, matches: 9 } })
    const client = scripted([submit('v1'), pass])
    const res = await delegate({ config: cfg, catalog, statePath, client, launchDir: workspace }, { task: 't', workspace, taskProfile: ['code-gen'] })
    expect(res.mode).toBe('single')
    expect(res.workerModel).toBe('w/coder')
  })

  it('records a strike and zero elo delta for a contestant that no-contest forfeits while the tournament still succeeds', async () => {
    plantState(statePath, { 'w/coder': { elo: 1000, matches: 0 }, 'w/coder2': { elo: 1000, matches: 0 }, 'w/coder3': { elo: 1000, matches: 0 } })
    const client = routedByModel({
      'w/coder': [submit('c1')],
      'w/coder2': [new NimError('degraded', 503)],
      'w/coder3': [submit('c3')],
      'r/rev': [verdictOfLabels],
    })
    const res = await delegate(
      { config: cfg, catalog, statePath, client, launchDir: workspace },
      { task: 't', workspace, taskProfile: ['code-gen'] },
    )
    expect(res.mode).toBe('tournament')
    const state = loadState(statePath, catalog)
    expect(state.models['w/coder2']?.availabilityStrikes).toBe(1)
    expect(res.arena?.eloDeltas['w/coder2']).toBe(0)
  })

  it('injects the worker model learnings as briefing in single mode', async () => {
    // Model names here are longer than in the shared `catalog` fixture: buildBriefing
    // scrubs every catalog id/name from the note, and single-letter names like 'W' or
    // 'R' would strip individual letters out of ordinary English prose.
    const scrubSafeCatalog: Registry = {
      ...catalog,
      models: catalog.models.map((m) => ({ ...m, name: `${m.name}-model` })),
    }
    saveState(statePath, {
      version: 1,
      judgeAgreement: { agree: 0, total: 0 },
      models: {
        'w/coder': {
          ratings: { 'code-gen': { elo: 1200, matches: 9 }, review: { elo: 1200, matches: 9 } },
          outcomes: { accepted: 0, reworked: 0, rejected: 0 }, availabilityStrikes: 0,
          learnings: [{ ts: '1', note: 'always run the full suite', tags: ['code-gen'] }],
        },
        'w/coder2': { ratings: { 'code-gen': { elo: 1000, matches: 9 } }, outcomes: { accepted: 0, reworked: 0, rejected: 0 }, availabilityStrikes: 0, learnings: [] },
        'w/coder3': { ratings: { 'code-gen': { elo: 990, matches: 9 } }, outcomes: { accepted: 0, reworked: 0, rejected: 0 }, availabilityStrikes: 0, learnings: [] },
      },
    })
    const systems: string[] = []
    const inner = scripted([submit('v1'), pass])
    const client = {
      calls: inner.calls,
      chat: async (p: { model: string; messages: Array<{ role: string; content: string | null }> }) => {
        const sys = p.messages.find((m) => m.role === 'system')
        if (sys?.content) systems.push(sys.content)
        return inner.chat(p)
      },
    }
    const res = await delegate(
      { config: cfg, catalog: scrubSafeCatalog, statePath, client, launchDir: workspace },
      { task: 't', workspace, taskProfile: ['code-gen'] },
    )
    expect(res.mode).toBe('single')
    expect(systems.some((s) => s.includes('always run the full suite'))).toBe(true)
  })

  it('aborted tournament writes a trace and records strikes', async () => {
    plantState(statePath, { 'w/coder': { elo: 1000, matches: 0 }, 'w/coder2': { elo: 1000, matches: 0 }, 'w/coder3': { elo: 1000, matches: 0 } })
    const client = { chat: async () => { throw new NimError('degraded', 400) } }
    await expect(delegate({ config: cfg, catalog, statePath, client, launchDir: workspace }, { task: 't', workspace, taskProfile: ['code-gen'] }))
      .rejects.toThrow(/forfeited/)
    const day = fs.readdirSync(path.join(workspace, '.runs'))[0]!
    const lines = fs.readFileSync(path.join(workspace, '.runs', day), 'utf8').trim().split('\n')
    expect(JSON.parse(lines[0]!)).toMatchObject({ kind: 'tournament', status: 'aborted' })
    expect(loadState(statePath, catalog).models['w/coder']?.availabilityStrikes).toBe(1)
  })

  it('tournament mode: records a learning note for a contestant that needed a verify-revision', async () => {
    // Only two code-gen-eligible workers in this catalog (unlike the shared `catalog` fixture,
    // which also has w/coder3 and would force a 3-contestant tournament requiring a third
    // scripted worker queue). Near-tied elo keeps this on the tournament path, not single.
    const twoWorkerCatalog: Registry = {
      version: 1,
      models: [
        { id: 'w/coder', name: 'W', tags: ['code-gen'], contextWindow: 1, toolCalling: 'reliable', outcomes: { accepted: 0, reworked: 0, rejected: 0 } },
        { id: 'w/coder2', name: 'W2', tags: ['code-gen'], contextWindow: 1, toolCalling: 'reliable', outcomes: { accepted: 0, reworked: 0, rejected: 0 } },
        { id: 'r/rev', name: 'R', tags: ['review'], contextWindow: 1, toolCalling: 'none', outcomes: { accepted: 0, reworked: 0, rejected: 0 } },
      ],
    }
    const gitWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-tverify-'))
    execFileSync('git', ['init', '-q'], { cwd: gitWorkspace })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: gitWorkspace })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: gitWorkspace })
    fs.writeFileSync(path.join(gitWorkspace, 'a.ts'), 'export const a = 1\n')
    // Fails until a "fixed.txt" file shows up in a contestant's changes, forcing exactly
    // one verify-revision round-trip per contestant (mirrors the single-mode fixture above).
    fs.writeFileSync(path.join(gitWorkspace, 'elodrome.verify.json'), '{"check": "test -f fixed.txt"}')
    execFileSync('git', ['add', '.'], { cwd: gitWorkspace })
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: gitWorkspace })

    plantState(statePath, {
      'w/coder': { elo: 1000, matches: 9 },
      'w/coder2': { elo: 995, matches: 9 },
    })

    const submitFix = (label: string) => reply({
      toolCalls: [{
        id: 's', name: 'submit_result',
        arguments: JSON.stringify({
          summary: label, rationale: 'r',
          changes: [{ path: 'fixed.txt', type: 'full', content: 'x' }],
        }),
      }],
    })

    const client = routedByModel({
      'w/coder': [submit('a1'), submitFix('a2')],
      'w/coder2': [submit('b1'), submitFix('b2')],
      'r/rev': [verdictOfLabels],
    })

    await delegate(
      { config: cfg, catalog: twoWorkerCatalog, statePath, client, launchDir: gitWorkspace },
      { task: 'do it', workspace: gitWorkspace, taskProfile: ['code-gen'] },
    )

    const state = loadState(statePath, twoWorkerCatalog)
    const learnings = state.models['w/coder']?.learnings ?? []
    const coder2Learnings = state.models['w/coder2']?.learnings ?? []
    const allNotes = [...learnings, ...coder2Learnings].map((l) => l.note)
    const revisionNotes = allNotes.filter((n) => n.includes('verify-revision'))
    // Both contestants self-corrected on their one revision attempt (the intended "good"
    // outcome of this feature) — by the time the learning note is written, outcome.verify[m]
    // holds the PASSING result, so the note must be built from the pre-revision failure
    // snapshot (verifyInitialFailures), not the final verify result, or it reads as an
    // empty, content-free "Needed a verify-revision () before passing."
    expect(revisionNotes.length).toBeGreaterThan(0)
    for (const note of revisionNotes) {
      expect(note).toContain('(check)')
      expect(note).not.toContain('()')
    }
  })
})
