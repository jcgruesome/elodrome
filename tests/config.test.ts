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
    expect(cfg.runsDir).toMatch(/\.elodrome\/runs$/)
    expect(cfg.requestsPerMinute).toBe(30)
    expect(cfg.maxWorkerRequests).toBe(25)
    expect(cfg.workerTimeoutMs).toBe(300_000)
  })

  it('honors env overrides', () => {
    const cfg = loadConfig({
      NVIDIA_API_KEY: 'k',
      ELODROME_BASE_URL: 'http://localhost:9999/v1',
      ELODROME_RPM: '5',
    })
    expect(cfg.baseUrl).toBe('http://localhost:9999/v1')
    expect(cfg.requestsPerMinute).toBe(5)
  })

  it('rejects non-numeric env overrides', () => {
    expect(() => loadConfig({ NVIDIA_API_KEY: 'k', ELODROME_RPM: 'abc' })).toThrow(/ELODROME_RPM/)
    expect(() => loadConfig({ NVIDIA_API_KEY: 'k', ELODROME_WORKER_TIMEOUT_MS: '-5' })).toThrow(/ELODROME_WORKER_TIMEOUT_MS/)
  })

  it('defaults and validates verifyTimeoutMs', () => {
    const cfg = loadConfig({ NVIDIA_API_KEY: 'k' })
    expect(cfg.verifyTimeoutMs).toBe(180_000)
    expect(() => loadConfig({ NVIDIA_API_KEY: 'k', ELODROME_VERIFY_TIMEOUT_MS: 'abc' })).toThrow(/ELODROME_VERIFY_TIMEOUT_MS/)
  })
})
