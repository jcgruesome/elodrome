import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it } from 'vitest'
import YAML from 'yaml'
import { loadConfig } from '../src/config'
import { buildServer, formatToolResult } from '../src/mcp/server'
import type { ChatResult } from '../src/nim/client'
import { loadRegistry } from '../src/registry/registry'
import { getRating, loadState, saveState } from '../src/registry/state'
import { appendTrace } from '../src/trace/trace'

let workspace: string
let registryPath: string
let statePath: string
let cfg: ReturnType<typeof loadConfig>

const registryYaml = `
version: 1
models:
  - { id: w/coder, name: W, tags: [code-gen], contextWindow: 128000, toolCalling: reliable }
  - { id: w/coder2, name: W2, tags: [code-gen], contextWindow: 128000, toolCalling: reliable }
  - { id: w/coder3, name: W3, tags: [code-gen], contextWindow: 128000, toolCalling: reliable }
  - { id: r/rev, name: R, tags: [review], contextWindow: 64000, toolCalling: none }
`

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-'))
  fs.writeFileSync(path.join(workspace, 'a.ts'), 'export const a = 1\n')
  registryPath = path.join(workspace, 'models.yaml')
  fs.writeFileSync(registryPath, registryYaml)
  cfg = loadConfig({ NVIDIA_API_KEY: 'k', NVAGENTS_RUNS_DIR: path.join(workspace, '.runs') })
  statePath = path.join(workspace, 'state.json')
  // Dominant champion so `delegate` exercises the single path deterministically.
  saveState(statePath, {
    version: 1,
    models: {
      'w/coder': {
        ratings: { 'code-gen': { elo: 1200, matches: 9 } },
        outcomes: { accepted: 0, reworked: 0, rejected: 0 },
        availabilityStrikes: 0,
        learnings: [],
      },
      'w/coder2': {
        ratings: { 'code-gen': { elo: 1000, matches: 9 } },
        outcomes: { accepted: 0, reworked: 0, rejected: 0 },
        availabilityStrikes: 0,
        learnings: [],
      },
    },
    judgeAgreement: { agree: 0, total: 0 },
  })
})

function reply(partial: Partial<ChatResult>): ChatResult {
  return {
    content: partial.content ?? null, toolCalls: [],
    assistantMessage: { role: 'assistant', content: partial.content ?? null },
    usage: { promptTokens: 1, completionTokens: 1 }, ...partial,
  }
}

const submit = reply({
  toolCalls: [{
    id: 's', name: 'submit_result',
    arguments: JSON.stringify({ summary: 'done', rationale: 'r', changes: [] }),
  }],
})
const pass = reply({ content: '{"verdict":"pass","issues":[]}' })

async function connect(replies: ChatResult[]) {
  let i = 0
  const client = { chat: async () => { const r = replies[i]; i += 1; if (!r) throw new Error('exhausted'); return r } }
  const server = buildServer({ config: cfg, registryPath, statePath, client, launchDir: workspace })
  const mcp = new Client({ name: 'test', version: '0.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), mcp.connect(b)])
  return mcp
}

function textOf(res: unknown): string {
  return (res as { content: Array<{ text: string }> }).content[0]!.text
}

describe('mcp server', () => {
  it('lists models with win rates', async () => {
    const mcp = await connect([])
    const res = await mcp.callTool({ name: 'list_models', arguments: {} })
    const parsed = JSON.parse(textOf(res)) as { models: Array<{ id: string; winRate: number }> }
    expect(parsed.models.map((m) => m.id)).toContain('w/coder')
    expect(parsed.models[0]?.winRate).toBe(0.5)
  })

  it('delegates end to end and then records an outcome', async () => {
    const mcp = await connect([submit, pass])
    const res = await mcp.callTool({
      name: 'delegate',
      arguments: { task: 't', workspace, task_profile: ['code-gen'] },
    })
    const parsed = JSON.parse(textOf(res)) as { runId: string; status: string }
    expect(parsed.status).toBe('ok')

    await mcp.callTool({ name: 'report_outcome', arguments: { run_id: parsed.runId, outcome: 'accepted' } })
    const registry = loadRegistry(registryPath)
    const state = loadState(statePath, registry)
    expect(state.models['w/coder']?.outcomes.accepted).toBe(1)
  })

  it('consult does a single chat with no tools', async () => {
    const mcp = await connect([reply({ content: 'second opinion' })])
    const res = await mcp.callTool({ name: 'consult', arguments: { model: 'r/rev', prompt: 'p' } })
    expect(textOf(res)).toContain('second opinion')
  })

  it('surfaces errors as MCP tool errors, not crashes', async () => {
    const mcp = await connect([])
    const res = await mcp.callTool({
      name: 'delegate',
      arguments: { task: 't', workspace: os.homedir(), task_profile: ['code-gen'] },
    })
    expect((res as { isError?: boolean }).isError).toBe(true)
    expect(textOf(res)).toMatch(/outside/i)
  })

  it('leaderboard tool returns ranked sections', async () => {
    const mcp = await connect([])
    const res = await mcp.callTool({ name: 'leaderboard', arguments: {} })
    const parsed = JSON.parse(textOf(res)) as { sections: Array<{ tag: string }> }
    expect(Array.isArray(parsed.sections)).toBe(true)
  })

  it('report_outcome nudges elo on the run profile tags', async () => {
    const mcp = await connect([submit, pass])
    const res = await mcp.callTool({ name: 'delegate', arguments: { task: 't', workspace, task_profile: ['code-gen'] } })
    const { runId } = JSON.parse(textOf(res)) as { runId: string }
    await mcp.callTool({ name: 'report_outcome', arguments: { run_id: runId, outcome: 'accepted' } })
    const state = loadState(statePath, loadRegistry(registryPath))
    expect(state.models['w/coder']?.outcomes.accepted).toBe(1)
    expect(getRating(state, 'w/coder', 'code-gen').elo).toBe(1208) // planted 1200 + 8
  })

  it('report_outcome stores a learning and rejects a second report', async () => {
    const mcp = await connect([submit, pass])
    const res = await mcp.callTool({ name: 'delegate', arguments: { task: 't', workspace, task_profile: ['code-gen'] } })
    const { runId } = JSON.parse(textOf(res)) as { runId: string }
    await mcp.callTool({
      name: 'report_outcome',
      arguments: { run_id: runId, outcome: 'reworked', learning: 'left dead code in the helper' },
    })
    const state = loadState(statePath, loadRegistry(registryPath))
    expect(state.models['w/coder']?.learnings.at(-1)?.note).toBe('left dead code in the helper')
    const second = await mcp.callTool({ name: 'report_outcome', arguments: { run_id: runId, outcome: 'accepted' } })
    expect((second as { isError?: boolean }).isError).toBe(true)
    expect(textOf(second)).toMatch(/already reported/)
  })

  it('report_outcome strips embedded newlines from a learning note before storing', async () => {
    const mcp = await connect([submit, pass])
    const res = await mcp.callTool({ name: 'delegate', arguments: { task: 't', workspace, task_profile: ['code-gen'] } })
    const { runId } = JSON.parse(textOf(res)) as { runId: string }
    await mcp.callTool({
      name: 'report_outcome',
      arguments: { run_id: runId, outcome: 'reworked', learning: 'left dead code\nin the helper' },
    })
    const state = loadState(statePath, loadRegistry(registryPath))
    const note = state.models['w/coder']?.learnings.at(-1)?.note
    expect(note).toBe('left dead code in the helper')
    expect(note).not.toMatch(/\n/)
  })

  it('report_outcome resolves concurrent double-calls for the same run_id exactly once', async () => {
    const mcp = await connect([submit, pass])
    const res = await mcp.callTool({ name: 'delegate', arguments: { task: 't', workspace, task_profile: ['code-gen'] } })
    const { runId } = JSON.parse(textOf(res)) as { runId: string }

    // Fire both calls together (not sequential awaits) so they race the idempotency guard.
    const [first, second] = await Promise.all([
      mcp.callTool({ name: 'report_outcome', arguments: { run_id: runId, outcome: 'accepted' } }),
      mcp.callTool({ name: 'report_outcome', arguments: { run_id: runId, outcome: 'accepted' } }),
    ])
    const results = [first, second] as Array<{ isError?: boolean }>
    const successes = results.filter((r) => !r.isError)
    const failures = results.filter((r) => r.isError)
    expect(successes).toHaveLength(1)
    expect(failures).toHaveLength(1)
    expect(textOf(failures[0])).toMatch(/already reported/)
    expect(JSON.parse(textOf(successes[0])) as { recorded: boolean }).toMatchObject({ recorded: true })

    // The critical assertion: only ONE application of the outcome landed, not two.
    const state = loadState(statePath, loadRegistry(registryPath))
    expect(state.models['w/coder']?.outcomes.accepted).toBe(1)
  })

  it('report_outcome rolls back its reservation on a genuine failure so a retry is not permanently blocked', async () => {
    const mcp = await connect([])
    const runId = 'run_not_yet_known'

    // First attempt fails for a reason unrelated to idempotency: no delegate trace exists yet.
    const first = await mcp.callTool({ name: 'report_outcome', arguments: { run_id: runId, outcome: 'accepted' } })
    expect((first as { isError?: boolean }).isError).toBe(true)
    expect(textOf(first)).toMatch(/Unknown run_id/)

    // The run_id becomes valid (its delegate trace lands). If the earlier failure had left a
    // stale reservation in the `reported` set, this retry would be wrongly rejected as a duplicate.
    appendTrace(cfg.runsDir, {
      kind: 'delegate', runId, workerModel: 'w/coder', taskProfile: ['code-gen'],
    })
    const second = await mcp.callTool({ name: 'report_outcome', arguments: { run_id: runId, outcome: 'accepted' } })
    expect((second as { isError?: boolean }).isError).not.toBe(true)
    expect(JSON.parse(textOf(second)) as { recorded: boolean }).toMatchObject({ recorded: true })
  })

  it('record_learning appends to any model and forget removes', async () => {
    const mcp = await connect([])
    await mcp.callTool({
      name: 'record_learning',
      arguments: { model: 'w/coder2', note: 'replies in prose instead of tool calls', tags: ['code-gen'] },
    })
    let state = loadState(statePath, loadRegistry(registryPath))
    expect(state.models['w/coder2']?.learnings[0]?.note).toContain('prose')
    await mcp.callTool({ name: 'record_learning', arguments: { model: 'w/coder2', forget: 'prose' } })
    state = loadState(statePath, loadRegistry(registryPath))
    expect(state.models['w/coder2']?.learnings).toHaveLength(0)
    const bad = await mcp.callTool({ name: 'record_learning', arguments: { model: 'w/coder2' } })
    expect((bad as { isError?: boolean }).isError).toBe(true)
    const unknown = await mcp.callTool({ name: 'record_learning', arguments: { model: 'no/such', note: 'a note long enough' } })
    expect((unknown as { isError?: boolean }).isError).toBe(true)
  })

  it('record_learning strips embedded newlines from the note before storing', async () => {
    const mcp = await connect([])
    await mcp.callTool({
      name: 'record_learning',
      arguments: { model: 'w/coder3', note: 'replies in prose\ninstead of tool calls' },
    })
    const state = loadState(statePath, loadRegistry(registryPath))
    const note = state.models['w/coder3']?.learnings[0]?.note
    expect(note).toBe('replies in prose instead of tool calls')
    expect(note).not.toMatch(/\n/)
  })

  it('list_models exposes latest learnings', async () => {
    const mcp = await connect([])
    await mcp.callTool({ name: 'record_learning', arguments: { model: 'w/coder', note: 'a visible learning note' } })
    const res = await mcp.callTool({ name: 'list_models', arguments: {} })
    const { models } = JSON.parse(textOf(res)) as { models: Array<{ id: string; learnings: Array<{ note: string }> }> }
    expect(models.find((m) => m.id === 'w/coder')?.learnings[0]?.note).toBe('a visible learning note')
  })
})

describe('formatToolResult', () => {
  it('inlines small payloads and offloads big ones', () => {
    const runsDir = path.join(workspace, '.runs')
    expect(formatToolResult(runsDir, 'run_x', { a: 1 })).toBe('{"a":1}')
    const big = { blob: 'x'.repeat(30_000) }
    const out = JSON.parse(formatToolResult(runsDir, 'run_big', big)) as { payloadPath: string; runId?: string }
    expect(fs.existsSync(out.payloadPath)).toBe(true)
    expect(YAML.parse(fs.readFileSync(out.payloadPath, 'utf8')).blob).toHaveLength(30_000)
    expect(out.runId).toBe('run_big')
  })

  it('surfaces status and summary in the envelope when offloading big payloads', () => {
    const runsDir = path.join(workspace, '.runs')
    const big = { blob: 'x'.repeat(30_000), status: 'failed_review', summary: 's' }
    const envelope = JSON.parse(formatToolResult(runsDir, 'run_status', big)) as { payloadPath: string; status?: string; summary?: string }
    expect(envelope.status).toBe('failed_review')
    expect(envelope.summary).toBe('s')
    expect(fs.existsSync(envelope.payloadPath)).toBe(true)
  })
})
