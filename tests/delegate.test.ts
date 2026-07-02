import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config'
import type { ChatResult } from '../src/nim/client'
import { delegate } from '../src/pipeline/delegate'
import type { Registry } from '../src/registry/schema'

const registry: Registry = {
  version: 1,
  models: [
    { id: 'w/coder', name: 'W', tags: ['code-gen'], contextWindow: 1, toolCalling: 'reliable', outcomes: { accepted: 0, reworked: 0, rejected: 0 } },
    { id: 'r/rev', name: 'R', tags: ['review'], contextWindow: 1, toolCalling: 'none', outcomes: { accepted: 0, reworked: 0, rejected: 0 } },
  ],
}

let workspace: string
let cfg: ReturnType<typeof loadConfig>
beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-'))
  fs.writeFileSync(path.join(workspace, 'a.ts'), 'export const a = 1\n')
  cfg = loadConfig({ NVIDIA_API_KEY: 'k', NVAGENTS_RUNS_DIR: path.join(workspace, '.runs') })
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

describe('delegate', () => {
  it('runs work -> critique -> ok without revision', async () => {
    const client = scripted([submit('v1'), pass])
    const res = await delegate(
      { config: cfg, registry, client, launchDir: workspace },
      { task: 't', workspace, taskProfile: ['code-gen'] },
    )
    expect(res.status).toBe('ok')
    expect(res.revised).toBe(false)
    expect(res.workerModel).toBe('w/coder')
    expect(res.reviewerModel).toBe('r/rev')
    expect(client.calls).toEqual(['w/coder', 'r/rev'])
    expect(res.changes[0]?.valid).toBe(true)
    expect(fs.readdirSync(path.join(workspace, '.runs'))).toHaveLength(1)
  })

  it('revises once after a failed critique', async () => {
    const client = scripted([submit('v1'), fail, submit('v2'), pass])
    const res = await delegate(
      { config: cfg, registry, client, launchDir: workspace },
      { task: 't', workspace, taskProfile: ['code-gen'] },
    )
    expect(res.status).toBe('ok')
    expect(res.revised).toBe(true)
    expect(res.summary).toBe('v2')
  })

  it('returns failed_review when critique still fails', async () => {
    const client = scripted([submit('v1'), fail, submit('v2'), fail])
    const res = await delegate(
      { config: cfg, registry, client, launchDir: workspace },
      { task: 't', workspace, taskProfile: ['code-gen'] },
    )
    expect(res.status).toBe('failed_review')
    expect(res.critique.issues).toContain('bug: off by one')
  })

  it('rejects an explicit model without reliable tool calling', async () => {
    const client = scripted([])
    await expect(delegate(
      { config: cfg, registry, client, launchDir: workspace },
      { task: 't', workspace, taskProfile: [], model: 'r/rev' },
    )).rejects.toThrow(/tool calling/i)
  })

  it('rejects a workspace outside the launch dir', async () => {
    const client = scripted([])
    await expect(delegate(
      { config: cfg, registry, client, launchDir: workspace },
      { task: 't', workspace: os.homedir(), taskProfile: ['code-gen'] },
    )).rejects.toThrow(/outside/i)
  })
})
