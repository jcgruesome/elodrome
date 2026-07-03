import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { appendTrace, findRunModel, newRunId } from '../src/trace/trace'

describe('trace', () => {
  it('generates unique ids with the run_ prefix', () => {
    const a = newRunId()
    expect(a).toMatch(/^run_[a-z0-9]+_[0-9a-f]{8}$/)
    expect(newRunId()).not.toBe(a)
  })

  it('appends JSONL records and finds the run model', () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'trace-')), 'runs')
    const runId = newRunId()
    appendTrace(dir, { kind: 'delegate', runId, workerModel: 'a/coder' })
    appendTrace(dir, { kind: 'outcome', runId, outcome: 'accepted' })
    const files = fs.readdirSync(dir)
    expect(files).toHaveLength(1)
    const lines = fs.readFileSync(path.join(dir, files[0]!), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!).ts).toBeTruthy()
    expect(findRunModel(dir, runId)).toBe('a/coder')
    expect(findRunModel(dir, 'run_nope_00000000')).toBeUndefined()
  })
})
