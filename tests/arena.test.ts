import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { ArenaAbortError, runArena } from '../src/arena/arena'
import { loadConfig } from '../src/config'
import { NimError, type ChatResult } from '../src/nim/client'
import type { ModelEntry } from '../src/registry/schema'
import { Sandbox } from '../src/sandbox/sandbox'

function model(id: string, tags: string[] = ['code-gen']): ModelEntry {
  return { id, name: id, tags: tags as ModelEntry['tags'], contextWindow: 1, toolCalling: 'reliable', outcomes: { accepted: 0, reworked: 0, rejected: 0 } }
}

let sandbox: Sandbox
let cfg: ReturnType<typeof loadConfig>
beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-'))
  fs.writeFileSync(path.join(root, 'a.ts'), 'export const a = 1\n')
  sandbox = new Sandbox(root)
  cfg = loadConfig({ NVIDIA_API_KEY: 'k' })
})

function reply(partial: Partial<ChatResult>): ChatResult {
  return {
    content: partial.content ?? null, toolCalls: [],
    assistantMessage: { role: 'assistant', content: partial.content ?? null },
    usage: { promptTokens: 1, completionTokens: 1 }, ...partial,
  }
}

const submit = (summary: string) => reply({
  toolCalls: [{ id: 's', name: 'submit_result', arguments: JSON.stringify({ summary, rationale: 'r', changes: [{ path: 'a.ts', type: 'full', content: 'x' }] }) }],
})

/** Routes chat calls by model id; each model consumes its own reply queue. */
function routedClient(queues: Record<string, Array<ChatResult | Error>>) {
  const state = Object.fromEntries(Object.entries(queues).map(([k, v]) => [k, [...v]]))
  return {
    chat: async (p: { model: string; messages?: Array<{ role: string; content: string | null }> }) => {
      const q = state[p.model]
      if (!q || q.length === 0) throw new Error(`no scripted reply for ${p.model}`)
      const next = q.shift()!
      if (next instanceof Error) throw next
      return next
    },
  }
}

const verdictFor = (ranking: string[], failLabel?: string) => reply({
  content: JSON.stringify({
    ranking,
    verdicts: Object.fromEntries(ranking.map((l) => [l, l === failLabel ? 'fail' : 'pass'])),
    issues: failLabel ? { [failLabel]: ['judge issue'] } : {},
  }),
})

// Labels depend on the runId hash order; both orders are covered by ranking helpers.
const bothOrders = [verdictFor(['A', 'B']), verdictFor(['A', 'B'])]

describe('runArena', () => {
  it('runs contestants, judges blind, returns a winner', async () => {
    const client = routedClient({
      'w/x': [submit('from x')],
      'w/y': [submit('from y')],
      'j/1': bothOrders.slice(0, 1),
      'j/2': bothOrders.slice(1),
    })
    const out = await runArena({
      client, config: cfg, sandbox, task: 't', runId: 'run_fixed',
      contestants: [model('w/x'), model('w/y')], judgePool: [model('j/1', ['review']), model('j/2', ['review'])],
      scrubNames: ['w/x', 'w/y'],
    })
    expect(out.ranking.filter((r) => r.place !== null)).toHaveLength(2)
    expect(out.winner.model).toBe(out.ranking[0]!.model)
    expect(out.revised).toBe(false)
    expect(out.judges).toEqual(['j/1', 'j/2'])
  })

  it('classifies forfeits: NimError = no_contest, WorkerError = loss', async () => {
    const { WorkerError } = await import('../src/worker/loop')
    const client = routedClient({
      'w/x': [submit('ok')],
      'w/y': [new NimError('degraded', 400)],
      'w/z': [Object.assign(new WorkerError('budget blown'))],
      'j/1': [reply({ content: '{"verdict":"pass","issues":[]}' })],
    })
    const out = await runArena({
      client, config: cfg, sandbox, task: 't', runId: 'run_fixed',
      contestants: [model('w/x'), model('w/y'), model('w/z')], judgePool: [model('j/1', ['review'])],
      scrubNames: [],
    })
    const noContest = out.ranking.find((r) => r.model === 'w/y')
    const loss = out.ranking.find((r) => r.model === 'w/z')
    expect(noContest?.forfeit).toBe('no_contest')
    expect(noContest?.place).toBeNull()
    expect(loss?.forfeit).toBe('loss')
    expect(loss?.place).toBe(2) // last place behind the single survivor
  })

  it('single survivor goes through v1 critique instead of judging', async () => {
    const critiquePass = reply({ content: '{"verdict":"pass","issues":[]}' })
    const client = routedClient({
      'w/x': [submit('ok')],
      'w/y': [new NimError('down', 503)],
      'j/1': [critiquePass],
    })
    const out = await runArena({
      client, config: cfg, sandbox, task: 't', runId: 'run_fixed',
      contestants: [model('w/x'), model('w/y')], judgePool: [model('j/1', ['review'])],
      scrubNames: [],
    })
    expect(out.winner.model).toBe('w/x')
    expect(out.agreement).toBeNull()
    expect(out.winnerVerdictPass).toBe(true)
  })

  it('revises the winner once when a judge fails it', async () => {
    const client = routedClient({
      'w/x': [submit('v1'), submit('v2')],
      'w/y': [submit('other')],
      'j/1': [verdictFor(['A', 'B'], 'A')],
      'j/2': [verdictFor(['A', 'B'], 'A')],
    })
    const out = await runArena({
      client, config: cfg, sandbox, task: 't', runId: 'run_fixed',
      contestants: [model('w/x'), model('w/y')], judgePool: [model('j/1', ['review']), model('j/2', ['review'])],
      scrubNames: [],
    })
    expect(out.revised).toBe(true)
    expect(out.winnerVerdictPass).toBe(false)
  })

  it('delivers each contestant its own briefing and none to judges', async () => {
    const systems: Record<string, string> = {}
    const base = routedClient({
      'w/x': [submit('from x')],
      'w/y': [submit('from y')],
      'j/1': [verdictFor(['A', 'B'])],
      'j/2': [verdictFor(['A', 'B'])],
    })
    const client = {
      chat: async (p: { model: string; messages: Array<{ role: string; content: string | null }> }) => {
        const sys = p.messages.find((m) => m.role === 'system')
        if (sys?.content) systems[p.model] = (systems[p.model] ?? '') + sys.content
        return base.chat(p)
      },
    }
    await runArena({
      client, config: cfg, sandbox, task: 't', runId: 'run_fixed',
      contestants: [model('w/x'), model('w/y')],
      judgePool: [model('j/1', ['review']), model('j/2', ['review'])],
      scrubNames: [],
      briefings: { 'w/x': '- x-specific coaching note' },
    })
    expect(systems['w/x']).toContain('x-specific coaching note')
    expect(systems['w/y'] ?? '').not.toContain('x-specific coaching note')
    expect(systems['j/1'] ?? '').not.toContain('coaching')
    expect(systems['j/2'] ?? '').not.toContain('coaching')
  })

  it('throws ArenaAbortError when everyone forfeits', async () => {
    const client = routedClient({
      'w/x': [new NimError('down', 503)],
      'w/y': [new NimError('down', 503)],
    })
    await expect(runArena({
      client, config: cfg, sandbox, task: 't', runId: 'run_fixed',
      contestants: [model('w/x'), model('w/y')], judgePool: [model('j/1', ['review'])],
      scrubNames: [],
    })).rejects.toThrow(ArenaAbortError)
  })
})

describe('self-verification', () => {
  function makeGitSandbox(): Sandbox {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-verify-'))
    execFileSync('git', ['init', '-q'], { cwd: dir })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1\n')
    return new Sandbox(dir)
  }

  function commitAll(dir: string, message: string): void {
    execFileSync('git', ['add', '.'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '-m', message], { cwd: dir })
  }

  it('excludes a contestant that still fails verification after its revision, without aborting the tournament', async () => {
    const gitSandbox = makeGitSandbox()
    fs.writeFileSync(path.join(gitSandbox.root, 'elodrome.verify.json'), '{"check": "test -f fixed.txt"}')
    commitAll(gitSandbox.root, 'init')

    const submitWithFix = reply({
      toolCalls: [{
        id: 'sb', name: 'submit_result',
        arguments: JSON.stringify({
          summary: 'b1', rationale: 'r',
          changes: [{ path: 'fixed.txt', type: 'full', content: 'x' }],
        }),
      }],
    })
    const critiquePass = reply({ content: '{"verdict":"pass","issues":[]}' })
    const client = routedClient({
      'w/a': [submit('a1'), submit('a2')],
      'w/b': [submitWithFix],
      'j/1': [critiquePass],
    })
    const outcome = await runArena({
      client, config: { ...cfg, verifyTimeoutMs: 5_000 }, sandbox: gitSandbox, task: 't', runId: 'r1',
      contestants: [model('w/a'), model('w/b')], judgePool: [model('j/1', ['review'])], scrubNames: [],
    })
    expect(outcome.winner.model).toBe('w/b')
    expect(outcome.verify['w/a']!.status).toBe('failed')
    expect(outcome.verifyRevisionUsed['w/a']).toBe(true)
  })

  it('lets a contestant win after passing verification on its revision attempt', async () => {
    const gitSandbox = makeGitSandbox()
    fs.writeFileSync(path.join(gitSandbox.root, 'elodrome.verify.json'), '{"check": "test -f fixed.txt"}')
    commitAll(gitSandbox.root, 'init')

    const submitWithFix = reply({
      toolCalls: [{
        id: 's2', name: 'submit_result',
        arguments: JSON.stringify({
          summary: 'fixed', rationale: 'r',
          changes: [{ path: 'fixed.txt', type: 'full', content: 'x' }],
        }),
      }],
    })
    const critiquePass = reply({ content: '{"verdict":"pass","issues":[]}' })
    const client = routedClient({
      'w/a': [submit('a1'), submitWithFix, critiquePass],
    })
    const outcome = await runArena({
      client, config: { ...cfg, verifyTimeoutMs: 5_000 }, sandbox: gitSandbox, task: 't', runId: 'r1',
      contestants: [model('w/a')], judgePool: [model('w/a')], scrubNames: [],
    })
    expect(outcome.winner.model).toBe('w/a')
    expect(outcome.verify['w/a']!.status).toBe('passed')
    expect(outcome.verifyRevisionUsed['w/a']).toBe(true)
  })

  it('skips verification (non-git sandbox) exactly as before this feature', async () => {
    const client = routedClient({
      'w/a': [submit('a1')],
      'w/b': [submit('b1')],
      'j/1': [verdictFor(['A', 'B'])],
    })
    const outcome = await runArena({
      client, config: cfg, sandbox, task: 't', runId: 'r1',
      contestants: [model('w/a'), model('w/b')], judgePool: [model('j/1', ['review'])], scrubNames: [],
    })
    expect(outcome.verify['w/a']!.status).toBe('skipped')
    expect(outcome.verify['w/b']!.status).toBe('skipped')
  })
})
