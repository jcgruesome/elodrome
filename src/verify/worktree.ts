import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { applyPatch } from 'diff'
import type { ValidatedChange } from '../patch/validate'
import { parseVerifyConfig, VERIFY_CONFIG_FILENAME, type VerifyConfig } from './config'

const execFileAsync = promisify(execFile)

export class VerifySkippedError extends Error {}

export interface PreparedWorktree {
  root: string
  config: VerifyConfig | undefined
}

export async function findGitRoot(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd })
    return stdout.trim()
  } catch {
    return undefined
  }
}

const LOCK_RETRY_ATTEMPTS = 3
const LOCK_RETRY_BASE_MS = 100
const LOCK_CONTENTION_RE = /already exists|index\.lock|unable to create/i

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

async function addWorktreeWithRetry(gitRoot: string, worktreeRoot: string): Promise<void> {
  for (let attempt = 1; attempt <= LOCK_RETRY_ATTEMPTS; attempt++) {
    try {
      await execFileAsync('git', ['worktree', 'add', '--detach', '--no-checkout', worktreeRoot], { cwd: gitRoot })
      return
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (attempt === LOCK_RETRY_ATTEMPTS || !LOCK_CONTENTION_RE.test(message)) {
        throw new VerifySkippedError(`git worktree add failed: ${message}`)
      }
      await sleep(LOCK_RETRY_BASE_MS * attempt)
    }
  }
}

export async function createVerifyWorktree(gitRoot: string): Promise<PreparedWorktree> {
  const worktreeRoot = path.join(os.tmpdir(), `elodrome-verify-${crypto.randomBytes(6).toString('hex')}`)
  await addWorktreeWithRetry(gitRoot, worktreeRoot)
  // Written to stderr (not stdout, which carries MCP stdio protocol frames) so a worktree
  // orphaned by a killed process can still be found and removed manually — this is the
  // only "cleanup visibility" this feature provides; see spec's Error Handling & Safety.
  process.stderr.write(`[elodrome] verify worktree created at ${worktreeRoot}\n`)

  try {
    await execFileAsync('git', ['-c', 'core.hooksPath=/dev/null', 'checkout', 'HEAD', '--', '.'], { cwd: worktreeRoot })
  } catch (err) {
    await removeVerifyWorktree(gitRoot, worktreeRoot)
    throw new VerifySkippedError(`git checkout failed in verify worktree: ${(err as Error).message}`)
  }

  const configPath = path.join(worktreeRoot, VERIFY_CONFIG_FILENAME)
  if (!fs.existsSync(configPath)) {
    return { root: worktreeRoot, config: undefined }
  }
  try {
    const config = parseVerifyConfig(fs.readFileSync(configPath, 'utf8'))
    return { root: worktreeRoot, config }
  } catch (err) {
    await removeVerifyWorktree(gitRoot, worktreeRoot)
    throw err
  }
}

export function applyChangesToWorktree(
  worktreeRoot: string,
  workspaceOffset: string,
  changes: ValidatedChange[],
): void {
  const resolvedRoot = path.resolve(worktreeRoot)
  const resolvedConfigPath = path.resolve(worktreeRoot, workspaceOffset, VERIFY_CONFIG_FILENAME)
  for (const change of changes) {
    const target = path.resolve(worktreeRoot, workspaceOffset, change.path)
    if (target.toLowerCase() === resolvedConfigPath.toLowerCase()) continue
    if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
      throw new Error(`Change path "${change.path}" escapes the verify worktree`)
    }
    if (change.type === 'full') {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, change.content)
      continue
    }
    const current = fs.readFileSync(target, 'utf8')
    const patched = applyPatch(current, change.content)
    if (patched === false) {
      throw new Error(`Diff for "${change.path}" failed to apply in the verify worktree`)
    }
    fs.writeFileSync(target, patched)
  }
}

export async function removeVerifyWorktree(gitRoot: string, worktreeRoot: string): Promise<void> {
  try {
    await execFileAsync('git', ['worktree', 'remove', '--force', worktreeRoot], { cwd: gitRoot })
  } catch {
    // Fall through to the defensive filesystem cleanup below regardless of why git's
    // own removal failed (e.g. the worktree was already gone, or never registered).
  }
  fs.rmSync(worktreeRoot, { recursive: true, force: true })
}
