import { describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config'
import { NimClient, NimError } from '../src/nim/client'
import { RateLimiter } from '../src/nim/queue'

const cfg = loadConfig({ NVIDIA_API_KEY: 'k' })

function apiError(status: number): Error & { status: number } {
  return Object.assign(new Error(`http ${status}`), { status })
}

function fakeApi(create: (body: unknown) => Promise<unknown>) {
  return { chat: { completions: { create } } }
}

const okResponse = {
  choices: [{
    message: {
      role: 'assistant',
      content: 'hi',
      tool_calls: [{ id: 't1', function: { name: 'read_file', arguments: '{"path":"a"}' } }],
    },
  }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
}

describe('RateLimiter', () => {
  it('waits only when the per-model window is full', () => {
    let t = 0
    const rl = new RateLimiter(2, () => t)
    expect(rl.take('m')).toBe(0)
    expect(rl.take('m')).toBe(0)
    expect(rl.take('m')).toBe(60_000)
    expect(rl.take('other-model')).toBe(0)
    t = 61_000
    expect(rl.take('other-model')).toBe(0)
  })
})

describe('NimClient', () => {
  it('normalizes a successful response', async () => {
    const client = new NimClient(cfg, new RateLimiter(100), fakeApi(async () => okResponse))
    const res = await client.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] })
    expect(res.content).toBe('hi')
    expect(res.toolCalls).toEqual([{ id: 't1', name: 'read_file', arguments: '{"path":"a"}' }])
    expect(res.usage).toEqual({ promptTokens: 10, completionTokens: 5 })
  })

  it('retries 429 then succeeds', async () => {
    vi.useFakeTimers()
    const create = vi.fn()
      .mockRejectedValueOnce(apiError(429))
      .mockResolvedValueOnce(okResponse)
    const client = new NimClient(cfg, new RateLimiter(100), fakeApi(create))
    const p = client.chat({ model: 'm', messages: [] })
    await vi.runAllTimersAsync()
    await expect(p).resolves.toBeTruthy()
    expect(create).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('gives up after 4 attempts on persistent 429', async () => {
    vi.useFakeTimers()
    const create = vi.fn().mockRejectedValue(apiError(429))
    const client = new NimClient(cfg, new RateLimiter(100), fakeApi(create))
    const p = client.chat({ model: 'm', messages: [] }).catch((e: unknown) => e)
    await vi.runAllTimersAsync()
    expect(await p).toBeInstanceOf(NimError)
    expect(create).toHaveBeenCalledTimes(4)
    vi.useRealTimers()
  })

  it('fails immediately on 404 with guidance', async () => {
    const client = new NimClient(cfg, new RateLimiter(100), fakeApi(async () => { throw apiError(404) }))
    await expect(client.chat({ model: 'gone', messages: [] }))
      .rejects.toThrow(/gone.*not found.*list_models/s)
  })
})
