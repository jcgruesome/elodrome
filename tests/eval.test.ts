import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config'
import { runEvalSuite } from '../src/eval/harness'
import { NimError, type ChatResult } from '../src/nim/client'
import { loadRegistry } from '../src/registry/registry'
import { loadState } from '../src/registry/state'

const registryYaml = `
version: 1
models:
  - { id: w/coder, name: W, tags: [code-gen], contextWindow: 128000, toolCalling: reliable }
  - { id: w/coder2, name: W2, tags: [code-gen], contextWindow: 128000, toolCalling: reliable }
  - { id: r/rev, name: R, tags: [review], contextWindow: 64000, toolCalling: none }
`

const suiteYaml = `
cases:
  - id: add-constant
    task: Add a constant b = 2 to a.ts
    profile: [code-gen]
    check: { contains: "const b = 2" }
  - id: impossible
    task: Do something the fake worker will not do
    profile: [code-gen]
    check: { contains: "unicorns" }
`

function reply(partial: Partial<ChatResult>): ChatResult {
  return {
    content: partial.content ?? null, toolCalls: [],
    assistantMessage: { role: 'assistant', content: partial.content ?? null },
    usage: { promptTokens: 1, completionTokens: 1 }, ...partial,
  }
}

describe('runEvalSuite', () => {
  it('scores cases and writes evalScore to state', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-'))
    fs.writeFileSync(path.join(workspace, 'a.ts'), 'export const a = 1\n')
    const registryPath = path.join(workspace, 'models.yaml')
    fs.writeFileSync(registryPath, registryYaml)
    const registryBefore = fs.readFileSync(registryPath, 'utf8')
    const suitePath = path.join(workspace, 'suite.yaml')
    fs.writeFileSync(suitePath, suiteYaml)
    const cfg = loadConfig({ NVIDIA_API_KEY: 'k', NVAGENTS_RUNS_DIR: path.join(workspace, '.runs') })
    const catalog = loadRegistry(registryPath)
    const statePath = path.join(workspace, 'state.json')
    // model is passed explicitly to runEvalSuite (via delegate's `model` field), so the
    // gate is bypassed regardless of state — no dominance planting required here.

    const submit = reply({
      toolCalls: [{
        id: 's', name: 'submit_result',
        arguments: JSON.stringify({ summary: 'ok', rationale: 'r', changes: [{ path: 'a.ts', type: 'full', content: 'export const a = 1\nexport const b = 2\n' }] }),
      }],
    })
    const pass = reply({ content: '{"verdict":"pass","issues":[]}' })
    const replies = [submit, pass, submit, pass]
    let i = 0

    const result = await runEvalSuite(
      {
        config: cfg,
        catalog,
        statePath,
        client: { chat: async () => replies[i++]! },
        launchDir: workspace,
      },
      { suitePath, workspace, modelId: 'w/coder' },
    )
    expect(result.total).toBe(2)
    expect(result.passed).toBe(1)
    expect(result.score).toBe(0.5)
    expect(result.failures).toEqual(['impossible'])
    expect(loadState(statePath, catalog).models['w/coder']?.evalScore).toBe(0.5)
    // Verify registry YAML is never rewritten
    const registryAfter = fs.readFileSync(registryPath, 'utf8')
    expect(registryAfter).toBe(registryBefore)
  })

  it('rethrows NimError infra failures instead of scoring them as case failures', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-'))
    fs.writeFileSync(path.join(workspace, 'a.ts'), 'export const a = 1\n')
    const registryPath = path.join(workspace, 'models.yaml')
    fs.writeFileSync(registryPath, registryYaml)
    const suitePath = path.join(workspace, 'suite.yaml')
    fs.writeFileSync(suitePath, suiteYaml)
    const cfg = loadConfig({ NVIDIA_API_KEY: 'k', NVAGENTS_RUNS_DIR: path.join(workspace, '.runs') })
    const catalog = loadRegistry(registryPath)
    const statePath = path.join(workspace, 'state.json')

    await expect(runEvalSuite(
      {
        config: cfg,
        catalog,
        statePath,
        client: { chat: async () => { throw new NimError('down', 503) } },
        launchDir: workspace,
      },
      { suitePath, workspace, modelId: 'w/coder' },
    )).rejects.toThrow(/down/)

    expect(fs.existsSync(statePath)).toBe(false)
  })

  it('rejects with a clear error when modelId is not in the catalog', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-'))
    fs.writeFileSync(path.join(workspace, 'a.ts'), 'export const a = 1\n')
    const registryPath = path.join(workspace, 'models.yaml')
    fs.writeFileSync(registryPath, registryYaml)
    const suitePath = path.join(workspace, 'suite.yaml')
    fs.writeFileSync(suitePath, suiteYaml)
    const cfg = loadConfig({ NVIDIA_API_KEY: 'k', NVAGENTS_RUNS_DIR: path.join(workspace, '.runs') })
    const catalog = loadRegistry(registryPath)
    const statePath = path.join(workspace, 'state.json')

    await expect(runEvalSuite(
      {
        config: cfg,
        catalog,
        statePath,
        client: { chat: async () => { throw new Error('should not be called') } },
        launchDir: workspace,
      },
      { suitePath, workspace, modelId: 'w/nope' },
    )).rejects.toThrow(/w\/nope/)
  })
})
