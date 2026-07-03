import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config'
import { buildCli } from '../src/cli/index'
import type { ChatResult } from '../src/nim/client'
import { saveState } from '../src/registry/state'

const registryYaml = `
version: 1
models:
  - { id: w/coder, name: W, tags: [code-gen], contextWindow: 128000, toolCalling: reliable }
  - { id: w/coder2, name: W2, tags: [code-gen], contextWindow: 128000, toolCalling: reliable }
  - { id: r/rev, name: R, tags: [review], contextWindow: 64000, toolCalling: none }
`

function setup() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-'))
  fs.writeFileSync(path.join(workspace, 'a.ts'), 'export {}')
  const registryPath = path.join(workspace, 'models.yaml')
  fs.writeFileSync(registryPath, registryYaml)
  const cfg = loadConfig({ NVIDIA_API_KEY: 'k', NVAGENTS_RUNS_DIR: path.join(workspace, '.runs') })
  const statePath = path.join(workspace, 'state.json')
  // Dominant champion so `run` exercises the single path deterministically.
  saveState(statePath, {
    version: 1,
    models: {
      'w/coder': {
        ratings: { 'code-gen': { elo: 1200, matches: 9 } },
        outcomes: { accepted: 0, reworked: 0, rejected: 0 },
        availabilityStrikes: 0,
      },
      'w/coder2': {
        ratings: { 'code-gen': { elo: 1000, matches: 9 } },
        outcomes: { accepted: 0, reworked: 0, rejected: 0 },
        availabilityStrikes: 0,
      },
    },
  })
  return { workspace, registryPath, statePath, cfg }
}

function reply(partial: Partial<ChatResult>): ChatResult {
  return {
    content: partial.content ?? null, toolCalls: [],
    assistantMessage: { role: 'assistant', content: partial.content ?? null },
    usage: { promptTokens: 1, completionTokens: 1 }, ...partial,
  }
}

describe('nva cli', () => {
  it('models prints the registry', async () => {
    const { workspace, registryPath, statePath, cfg } = setup()
    const out: string[] = []
    const cli = buildCli({
      config: cfg, registryPath, statePath, launchDir: workspace,
      client: { chat: async () => { throw new Error('unused') } },
      print: (s) => out.push(s),
    })
    await cli.parseAsync(['node', 'nva', 'models'])
    expect(out.join('\n')).toContain('w/coder')
    expect(out.join('\n')).toContain('reliable')
  })

  it('run delegates and prints JSON', async () => {
    const { workspace, registryPath, statePath, cfg } = setup()
    const replies = [
      reply({ toolCalls: [{ id: 's', name: 'submit_result', arguments: JSON.stringify({ summary: 'done', rationale: 'r', changes: [] }) }] }),
      reply({ content: '{"verdict":"pass","issues":[]}' }),
    ]
    let i = 0
    const out: string[] = []
    const cli = buildCli({
      config: cfg, registryPath, statePath, launchDir: workspace,
      client: { chat: async () => replies[i++]! },
      print: (s) => out.push(s),
    })
    await cli.parseAsync(['node', 'nva', 'run', '--task', 't', '--workspace', workspace, '--profile', 'code-gen'])
    const parsed = JSON.parse(out.join('')) as { status: string }
    expect(parsed.status).toBe('ok')
  })

  it('leaderboard prints ranked models', async () => {
    const { workspace, registryPath, cfg, statePath } = setup()
    const out: string[] = []
    const cli = buildCli({
      config: cfg, registryPath, statePath, launchDir: workspace,
      client: { chat: async () => { throw new Error('unused') } },
      print: (s) => out.push(s),
    })
    await cli.parseAsync(['node', 'nva', 'leaderboard', '--tag', 'code-gen'])
    expect(out.join('\n')).toMatch(/1\s+w\/coder\s+1200\s+9/)
  })

  it('leaderboard --md prints markdown', async () => {
    const { workspace, registryPath, cfg, statePath } = setup()
    const out: string[] = []
    const cli = buildCli({
      config: cfg, registryPath, statePath, launchDir: workspace,
      client: { chat: async () => { throw new Error('unused') } },
      print: (s) => out.push(s),
    })
    await cli.parseAsync(['node', 'nva', 'leaderboard', '--md'])
    expect(out.join('\n')).toContain('## code-gen')
    expect(out.join('\n')).toContain('| 1 | w/coder | 1200 | 9 |')
  })
})
