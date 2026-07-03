import os from 'node:os'
import path from 'node:path'

export interface Config {
  apiKey: string
  baseUrl: string
  runsDir: string
  requestsPerMinute: number
  maxWorkerRequests: number
  workerTimeoutMs: number
}

function positiveNumber(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) {
    return fallback
  }
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got "${raw}"`)
  }
  return value
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKey = env.NVIDIA_API_KEY
  if (!apiKey) {
    throw new Error('NVIDIA_API_KEY is not set. Export it before running elodrome.')
  }
  return {
    apiKey,
    baseUrl: env.ELODROME_BASE_URL ?? 'https://integrate.api.nvidia.com/v1',
    runsDir: env.ELODROME_RUNS_DIR ?? path.join(os.homedir(), '.elodrome', 'runs'),
    requestsPerMinute: positiveNumber('ELODROME_RPM', env.ELODROME_RPM, 30),
    maxWorkerRequests: positiveNumber('ELODROME_MAX_WORKER_REQUESTS', env.ELODROME_MAX_WORKER_REQUESTS, 25),
    workerTimeoutMs: positiveNumber('ELODROME_WORKER_TIMEOUT_MS', env.ELODROME_WORKER_TIMEOUT_MS, 300_000),
  }
}
