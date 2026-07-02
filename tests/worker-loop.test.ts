import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type { ChatResult } from '../src/nim/client'
import { Sandbox } from '../src/sandbox/sandbox'
import { runWorkerLoop, WorkerError } from '../src/worker/loop'

let sbx: Sandbox
beforeAll(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-'))
  fs.writeFileSync(path.join(root, 'a.ts'), 'export const a = 1\n')
  sbx = new Sandbox(root)
})

function reply(partial: Partial<ChatResult>): ChatResult {
  return {
    content: null,
    toolCalls: [],
    assistantMessage: { role: 'assistant', content: null },
    usage: { promptTokens: 1, completionTokens: 1 },
    ...partial,
  }
}

const submitArgs = JSON.stringify({
  summary: 'done', rationale: 'because',
  changes: [{ path: 'a.ts', type: 'full', content: 'export const a = 2\n' }],
})

function scriptedClient(replies: ChatResult[]) {
  let i = 0
  return { chat: async () => { const r = replies[i]; i += 1; if (!r) throw new Error('script exhausted'); return r } }
}

describe('runWorkerLoop', () => {
  it('executes tools then returns the submitted result', async () => {
    const client = scriptedClient([
      reply({ toolCalls: [{ id: '1', name: 'read_file', arguments: '{"path":"a.ts"}' }] }),
      reply({ toolCalls: [{ id: '2', name: 'submit_result', arguments: submitArgs }] }),
    ])
    const { result, stats } = await runWorkerLoop({ client, model: 'm', task: 't', sandbox: sbx })
    expect(result.summary).toBe('done')
    expect(result.changes).toHaveLength(1)
    expect(stats.requests).toBe(2)
  })

  it('feeds sandbox errors back to the model instead of dying', async () => {
    const client = scriptedClient([
      reply({ toolCalls: [{ id: '1', name: 'read_file', arguments: '{"path":".env"}' }] }),
      reply({ toolCalls: [{ id: '2', name: 'submit_result', arguments: submitArgs }] }),
    ])
    const { result } = await runWorkerLoop({ client, model: 'm', task: 't', sandbox: sbx })
    expect(result.summary).toBe('done')
  })

  it('repairs one malformed submit then errors on the second', async () => {
    const bad = reply({ toolCalls: [{ id: 'x', name: 'submit_result', arguments: '{"nope":true}' }] })
    const client = scriptedClient([bad, bad])
    await expect(runWorkerLoop({ client, model: 'm', task: 't', sandbox: sbx }))
      .rejects.toThrow(WorkerError)
  })

  it('nudges once on toolless replies then errors', async () => {
    const chatty = reply({ content: 'here is my answer in prose' })
    const client = scriptedClient([chatty, chatty])
    await expect(runWorkerLoop({ client, model: 'm', task: 't', sandbox: sbx }))
      .rejects.toThrow(/tool/i)
  })

  it('enforces the request budget', async () => {
    const digging = reply({ toolCalls: [{ id: '1', name: 'list_dir', arguments: '{"path":"."}' }] })
    const client = scriptedClient(Array.from({ length: 4 }, () => digging))
    await expect(runWorkerLoop({ client, model: 'm', task: 't', sandbox: sbx, maxRequests: 3 }))
      .rejects.toThrow(/request budget/i)
  })

  it('enforces the wall clock', async () => {
    let t = 0
    const client = {
      chat: async () => { t += 400_000; return reply({ toolCalls: [{ id: '1', name: 'list_dir', arguments: '{"path":"."}' }] }) },
    }
    await expect(runWorkerLoop({ client, model: 'm', task: 't', sandbox: sbx, now: () => t }))
      .rejects.toThrow(/timed out/i)
  })
})
