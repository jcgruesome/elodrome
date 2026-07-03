import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export function newRunId(): string {
  return `run_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`
}

export function appendTrace(runsDir: string, record: Record<string, unknown>): void {
  fs.mkdirSync(runsDir, { recursive: true })
  const day = new Date().toISOString().slice(0, 10)
  const line = JSON.stringify({ ts: new Date().toISOString(), ...record })
  fs.appendFileSync(path.join(runsDir, `${day}.jsonl`), `${line}\n`)
}

export interface RunRef { model: string; tags: string[] }

// One truncated/corrupt line anywhere in the runs directory (e.g. a crash mid-append)
// must not stop the scan for a real match in the rest of the file — skip it and
// keep going, matching the skip-and-continue pattern src/board/data.ts already uses.
function tryParseLine(line: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(line) as Record<string, unknown>
  } catch {
    return undefined
  }
}

export function findRun(runsDir: string, runId: string): RunRef | undefined {
  if (!fs.existsSync(runsDir)) return undefined
  for (const file of fs.readdirSync(runsDir).filter((f) => f.endsWith('.jsonl'))) {
    for (const line of fs.readFileSync(path.join(runsDir, file), 'utf8').split('\n')) {
      if (!line.trim()) continue
      const rec = tryParseLine(line)
      if (!rec) continue
      if (
        rec.runId === runId
        && (rec.kind === 'delegate' || rec.kind === 'tournament')
        && typeof rec.workerModel === 'string'
      ) {
        return { model: rec.workerModel, tags: (rec.taskProfile as string[] | undefined) ?? [] }
      }
    }
  }
  return undefined
}

export function findRunModel(runsDir: string, runId: string): string | undefined {
  return findRun(runsDir, runId)?.model
}

export function hasOutcome(runsDir: string, runId: string): boolean {
  if (!fs.existsSync(runsDir)) return false
  for (const file of fs.readdirSync(runsDir).filter((f) => f.endsWith('.jsonl'))) {
    for (const line of fs.readFileSync(path.join(runsDir, file), 'utf8').split('\n')) {
      if (!line.trim()) continue
      const rec = tryParseLine(line)
      if (!rec) continue
      if (rec.kind === 'outcome' && rec.runId === runId) return true
    }
  }
  return false
}
