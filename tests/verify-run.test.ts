import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { __resetVerifyConcurrencyForTests, runCommands } from '../src/verify/run'

let cwd: string
beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'vrun-'))
})
afterEach(() => {
  delete process.env.ELODROME_MAX_CONCURRENT_VERIFY
  __resetVerifyConcurrencyForTests()
})

describe('runCommands', () => {
  it('reports a passing command with exit code 0', async () => {
    const results = await runCommands(cwd, { ok: 'exit 0' }, 5_000)
    expect(results).toEqual([{ name: 'ok', exitCode: 0, output: '' }])
  })

  it('reports a failing command with its non-zero exit code and output', async () => {
    const results = await runCommands(cwd, { bad: 'echo boom && exit 1' }, 5_000)
    expect(results).toHaveLength(1)
    expect(results[0]!.exitCode).toBe(1)
    expect(results[0]!.output).toContain('boom')
  })

  it('runs all commands even when one fails (no short-circuit)', async () => {
    const results = await runCommands(cwd, { a: 'exit 1', b: 'exit 0' }, 5_000)
    const byName = Object.fromEntries(results.map((r) => [r.name, r.exitCode]))
    expect(byName).toEqual({ a: 1, b: 0 })
  })

  it('kills a command that exceeds the timeout and reports it', async () => {
    const results = await runCommands(cwd, { slow: 'sleep 5' }, 200)
    expect(results).toHaveLength(1)
    expect(results[0]!.exitCode).toBeNull()
    expect(results[0]!.output).toMatch(/timed out/)
  }, 10_000)

  it('truncates very long output', async () => {
    const results = await runCommands(cwd, { chatty: "node -e \"process.stdout.write('x'.repeat(10000))\"" }, 5_000)
    expect(results[0]!.output.length).toBeLessThan(5_000)
    expect(results[0]!.output).toContain('[truncated]')
  })

  it('bounds total concurrency across a single call', async () => {
    process.env.ELODROME_MAX_CONCURRENT_VERIFY = '1'
    __resetVerifyConcurrencyForTests()
    const start = Date.now()
    await runCommands(cwd, { a: 'sleep 0.3', b: 'sleep 0.3' }, 5_000)
    expect(Date.now() - start).toBeGreaterThanOrEqual(550)
  }, 10_000)
})
