import path from 'node:path'
import type { ValidatedChange } from '../patch/validate'
import type { Sandbox } from '../sandbox/sandbox'
import type { CheckResult } from './run'
import { runCommands } from './run'
import {
  applyChangesToWorktree, createVerifyWorktree, findGitRoot, removeVerifyWorktree,
  VerifySkippedError, type PreparedWorktree,
} from './worktree'

export interface VerifyResult {
  status: 'skipped' | 'passed' | 'failed'
  checks: CheckResult[]
  reason?: string
}

export function verifyFailureMessages(verify: VerifyResult): string[] {
  if (verify.status !== 'failed') return []
  return verify.checks
    .filter((c) => c.exitCode !== 0)
    .map((c) => `check "${c.name}" failed:\n${c.output}`)
}

export async function verifyChanges(
  sandbox: Sandbox,
  changes: ValidatedChange[],
  timeoutMs: number,
): Promise<VerifyResult> {
  const gitRoot = await findGitRoot(sandbox.root)
  if (!gitRoot) {
    return { status: 'skipped', checks: [], reason: 'not a git repository' }
  }

  let worktree: PreparedWorktree
  try {
    worktree = await createVerifyWorktree(gitRoot)
  } catch (err) {
    if (err instanceof VerifySkippedError) {
      return { status: 'skipped', checks: [], reason: err.message }
    }
    throw err
  }

  try {
    if (!worktree.config || Object.keys(worktree.config).length === 0) {
      return { status: 'skipped', checks: [], reason: 'no elodrome.verify.json configured' }
    }
    const workspaceOffset = path.relative(gitRoot, sandbox.root)
    try {
      applyChangesToWorktree(worktree.root, workspaceOffset, changes)
    } catch (err) {
      return {
        status: 'failed',
        checks: [{ name: 'apply', exitCode: null, output: (err as Error).message }],
      }
    }
    const checks = await runCommands(path.join(worktree.root, workspaceOffset), worktree.config, timeoutMs)
    const status = checks.every((c) => c.exitCode === 0) ? 'passed' : 'failed'
    return { status, checks }
  } finally {
    await removeVerifyWorktree(gitRoot, worktree.root)
  }
}
