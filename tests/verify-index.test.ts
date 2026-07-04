import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ValidatedChange } from '../src/patch/validate'
import { Sandbox } from '../src/sandbox/sandbox'
import { VERIFY_CONFIG_FILENAME } from '../src/verify/config'
import { verifyChanges, verifyFailureMessages } from '../src/verify/index'

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd })
}

function initRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vidx-'))
  git(root, 'init', '-q')
  git(root, 'config', 'user.email', 'test@example.com')
  git(root, 'config', 'user.name', 'Test')
  fs.writeFileSync(path.join(root, 'a.ts'), 'export const a = 1\n')
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'init')
  return root
}

let root: string
let sandbox: Sandbox
beforeEach(() => {
  root = initRepo()
  sandbox = new Sandbox(root)
})

describe('verifyChanges', () => {
  it('skips when the workspace is not a git repository', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'vidx-plain-'))
    const result = await verifyChanges(new Sandbox(plain), [], 5_000)
    expect(result).toEqual({ status: 'skipped', checks: [], reason: 'not a git repository' })
  })

  it('skips when no elodrome.verify.json is configured', async () => {
    const result = await verifyChanges(sandbox, [], 5_000)
    expect(result.status).toBe('skipped')
  })

  it('passes when the configured command exits 0', async () => {
    fs.writeFileSync(path.join(root, VERIFY_CONFIG_FILENAME), '{"ok": "exit 0"}')
    git(root, 'add', '.')
    git(root, 'commit', '-q', '-m', 'add config')
    const result = await verifyChanges(sandbox, [], 5_000)
    expect(result.status).toBe('passed')
  })

  it('fails and reports all failing checks when a configured command exits non-zero', async () => {
    fs.writeFileSync(path.join(root, VERIFY_CONFIG_FILENAME), '{"bad": "exit 1", "ok": "exit 0"}')
    git(root, 'add', '.')
    git(root, 'commit', '-q', '-m', 'add config')
    const result = await verifyChanges(sandbox, [], 5_000)
    expect(result.status).toBe('failed')
    expect(verifyFailureMessages(result)).toHaveLength(1)
    expect(verifyFailureMessages(result)[0]).toContain('bad')
  })

  it('applies a proposed change before running checks', async () => {
    fs.writeFileSync(
      path.join(root, VERIFY_CONFIG_FILENAME),
      '{"check": "test -f new-file.txt && echo yes"}',
    )
    git(root, 'add', '.')
    git(root, 'commit', '-q', '-m', 'add config')
    const changes: ValidatedChange[] = [
      { path: 'new-file.txt', type: 'full', content: 'hello\n', valid: true },
    ]
    const result = await verifyChanges(sandbox, changes, 5_000)
    expect(result.status).toBe('passed')
    expect(result.checks[0]!.output).toContain('yes')
  })

  it('throws (fails fast) on a malformed elodrome.verify.json rather than skipping', async () => {
    fs.writeFileSync(path.join(root, VERIFY_CONFIG_FILENAME), 'not json')
    git(root, 'add', '.')
    git(root, 'commit', '-q', '-m', 'bad config')
    await expect(verifyChanges(sandbox, [], 5_000)).rejects.toThrow()
  })

  it('SECURITY: a change to elodrome.verify.json cannot alter what runs during its own verification', async () => {
    fs.writeFileSync(path.join(root, VERIFY_CONFIG_FILENAME), '{"check": "echo original-command-ran"}')
    git(root, 'add', '.')
    git(root, 'commit', '-q', '-m', 'add config')
    const maliciousChanges: ValidatedChange[] = [
      { path: VERIFY_CONFIG_FILENAME, type: 'full', content: '{"check": "echo PWNED"}', valid: true },
    ]
    const result = await verifyChanges(sandbox, maliciousChanges, 5_000)
    expect(result.status).toBe('passed')
    expect(result.checks[0]!.output).toContain('original-command-ran')
    expect(result.checks[0]!.output).not.toContain('PWNED')
  })
})

describe('verifyFailureMessages', () => {
  it('returns an empty array for a non-failed result', () => {
    expect(verifyFailureMessages({ status: 'passed', checks: [] })).toEqual([])
    expect(verifyFailureMessages({ status: 'skipped', checks: [] })).toEqual([])
  })
})
