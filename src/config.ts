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
    throw new Error('NVIDIA_API_KEY is not set. Export it before running nv-agents.')
  }
  return {
    apiKey,
    baseUrl: env.NVAGENTS_BASE_URL ?? 'https://integrate.api.nvidia.com/v1',
    runsDir: env.NVAGENTS_RUNS_DIR ?? path.join(os.homedir(), '.nv-agents', 'runs'),
    requestsPerMinute: positiveNumber('NVAGENTS_RPM', env.NVAGENTS_RPM, 30),
    maxWorkerRequests: positiveNumber('NVAGENTS_MAX_WORKER_REQUESTS', env.NVAGENTS_MAX_WORKER_REQUESTS, 25),
    workerTimeoutMs: positiveNumber('NVAGENTS_WORKER_TIMEOUT_MS', env.NVAGENTS_WORKER_TIMEOUT_MS, 300_000),
  }
}
