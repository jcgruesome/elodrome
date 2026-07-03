import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config'
import { buildCli } from '../src/cli/index'
import type { ChatResult } from '../src/nim/client'

const registryYaml = `
version: 1
models:
  - { id: w/coder, name: W, tags: [code-gen], contextWindow: 128000, toolCalling: reliable }
  - { id: r/rev, name: R, tags: [review], contextWindow: 64000, toolCalling: none }
`

function setup() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-'))
  fs.writeFileSync(path.join(workspace, 'a.ts'), 'export {}')
  const registryPath = path.join(workspace, 'models.yaml')
  fs.writeFileSync(registryPath, registryYaml)
  const cfg = loadConfig({ NVIDIA_API_KEY: 'k', NVAGENTS_RUNS_DIR: path.join(workspace, '.runs') })
  return { workspace, registryPath, cfg }
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
    const { workspace, registryPath, cfg } = setup()
    const out: string[] = []
    const cli = buildCli({
      config: cfg, registryPath, launchDir: workspace,
      client: { chat: async () => { throw new Error('unused') } },
      print: (s) => out.push(s),
    })
    await cli.parseAsync(['node', 'nva', 'models'])
    expect(out.join('\n')).toContain('w/coder')
    expect(out.join('\n')).toContain('reliable')
  })

  it('run delegates and prints JSON', async () => {
    const { workspace, registryPath, cfg } = setup()
    const replies = [
      reply({ toolCalls: [{ id: 's', name: 'submit_result', arguments: JSON.stringify({ summary: 'done', rationale: 'r', changes: [] }) }] }),
      reply({ content: '{"verdict":"pass","issues":[]}' }),
    ]
    let i = 0
    const out: string[] = []
    const cli = buildCli({
      config: cfg, registryPath, launchDir: workspace,
      client: { chat: async () => replies[i++]! },
      print: (s) => out.push(s),
    })
    await cli.parseAsync(['node', 'nva', 'run', '--task', 't', '--workspace', workspace, '--profile', 'code-gen'])
    const parsed = JSON.parse(out.join('')) as { status: string }
    expect(parsed.status).toBe('ok')
  })
})
