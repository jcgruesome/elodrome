import { execFile } from 'node:child_process'

export interface CheckResult { name: string; exitCode: number | null; output: string }

const DEFAULT_MAX_CONCURRENT = 4
const MAX_OUTPUT_CHARS = 4_000

function truncate(s: string): string {
  return s.length > MAX_OUTPUT_CHARS ? `${s.slice(0, MAX_OUTPUT_CHARS)}\n[truncated]` : s
}

function getMaxConcurrent(): number {
  const raw = process.env.ELODROME_MAX_CONCURRENT_VERIFY
  const n = raw === undefined ? DEFAULT_MAX_CONCURRENT : Number(raw)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_CONCURRENT
}

class Semaphore {
  private available: number
  private readonly queue: Array<() => void> = []

  constructor(limit: number) {
    this.available = limit
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1
      return
    }
    await new Promise<void>((resolve) => { this.queue.push(resolve) })
  }

  release(): void {
    const next = this.queue.shift()
    if (next) {
      next()
      return
    }
    this.available += 1
  }
}

let sharedSemaphore: Semaphore | undefined

function getSemaphore(): Semaphore {
  if (!sharedSemaphore) sharedSemaphore = new Semaphore(getMaxConcurrent())
  return sharedSemaphore
}

export function __resetVerifyConcurrencyForTests(): void {
  sharedSemaphore = undefined
}

function runOne(name: string, command: string, cwd: string, timeoutMs: number): Promise<CheckResult> {
  return new Promise((resolve) => {
    execFile(
      'sh',
      ['-c', command],
      { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        const output = truncate(`${stdout}${stderr}`)
        if (!error) {
          resolve({ name, exitCode: 0, output })
          return
        }
        if (error.killed && error.signal) {
          resolve({ name, exitCode: null, output: `${output}\ntimed out after ${timeoutMs}ms`.trim() })
          return
        }
        resolve({ name, exitCode: typeof error.code === 'number' ? error.code : 1, output })
      },
    )
  })
}

export async function runCommands(
  cwd: string,
  commands: Record<string, string>,
  timeoutMs: number,
): Promise<CheckResult[]> {
  const semaphore = getSemaphore()
  return Promise.all(Object.entries(commands).map(async ([name, command]) => {
    await semaphore.acquire()
    try {
      return await runOne(name, command, cwd, timeoutMs)
    } finally {
      semaphore.release()
    }
  }))
}
