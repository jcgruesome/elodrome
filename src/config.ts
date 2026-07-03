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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKey = env.NVIDIA_API_KEY
  if (!apiKey) {
    throw new Error('NVIDIA_API_KEY is not set. Export it before running nv-agents.')
  }
  return {
    apiKey,
    baseUrl: env.NVAGENTS_BASE_URL ?? 'https://integrate.api.nvidia.com/v1',
    runsDir: env.NVAGENTS_RUNS_DIR ?? path.join(os.homedir(), '.nv-agents', 'runs'),
    requestsPerMinute: Number(env.NVAGENTS_RPM ?? 30),
    maxWorkerRequests: Number(env.NVAGENTS_MAX_WORKER_REQUESTS ?? 25),
    workerTimeoutMs: Number(env.NVAGENTS_WORKER_TIMEOUT_MS ?? 300_000),
  }
}
