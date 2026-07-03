import { describe, expect, it } from 'vitest'
import type { ChatResult } from '../src/nim/client'
import { runCritique } from '../src/pipeline/critique'
import type { WorkerResult } from '../src/worker/output'

const worker: WorkerResult = {
  summary: 's', rationale: 'r',
  changes: [{ path: 'a.ts', type: 'full', content: 'export {}' }],
}

function textReply(content: string): ChatResult {
  return {
    content, toolCalls: [],
    assistantMessage: { role: 'assistant', content },
    usage: { promptTokens: 1, completionTokens: 1 },
  }
}

function scripted(replies: ChatResult[]) {
  let i = 0
  return { chat: async () => { const r = replies[i]; i += 1; if (!r) throw new Error('exhausted'); return r } }
}

describe('runCritique', () => {
  it('parses a clean JSON verdict', async () => {
    const c = await runCritique(scripted([textReply('{"verdict":"pass","issues":[]}')]), 'rev', 'task', worker)
    expect(c.verdict).toBe('pass')
  })

  it('extracts JSON wrapped in prose', async () => {
    const c = await runCritique(
      scripted([textReply('Here is my review:\n{"verdict":"fail","issues":["missing test"]}\nThanks!')]),
      'rev', 'task', worker,
    )
    expect(c).toEqual({ verdict: 'fail', issues: ['missing test'] })
  })

  it('retries once on garbage then succeeds', async () => {
    const c = await runCritique(
      scripted([textReply('I feel good about it'), textReply('{"verdict":"pass","issues":[]}')]),
      'rev', 'task', worker,
    )
    expect(c.verdict).toBe('pass')
  })

  it('throws after two unparseable replies', async () => {
    await expect(runCritique(scripted([textReply('nope'), textReply('still nope')]), 'rev', 'task', worker))
      .rejects.toThrow(/critique/i)
  })
})
