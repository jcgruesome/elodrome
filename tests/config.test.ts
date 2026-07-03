import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config'

describe('loadConfig', () => {
  it('throws when NVIDIA_API_KEY is missing', () => {
    expect(() => loadConfig({})).toThrow(/NVIDIA_API_KEY/)
  })

  it('returns defaults with only the key set', () => {
    const cfg = loadConfig({ NVIDIA_API_KEY: 'k' })
    expect(cfg.apiKey).toBe('k')
    expect(cfg.baseUrl).toBe('https://integrate.api.nvidia.com/v1')
    expect(cfg.runsDir).toMatch(/\.nv-agents\/runs$/)
    expect(cfg.requestsPerMinute).toBe(30)
    expect(cfg.maxWorkerRequests).toBe(25)
    expect(cfg.workerTimeoutMs).toBe(300_000)
  })

  it('honors env overrides', () => {
    const cfg = loadConfig({
      NVIDIA_API_KEY: 'k',
      NVAGENTS_BASE_URL: 'http://localhost:9999/v1',
      NVAGENTS_RPM: '5',
    })
    expect(cfg.baseUrl).toBe('http://localhost:9999/v1')
    expect(cfg.requestsPerMinute).toBe(5)
  })
})
