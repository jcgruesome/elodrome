import fs from 'node:fs'
import { applyPatch } from 'diff'
import { Sandbox, SandboxError } from '../sandbox/sandbox'
import type { Change } from '../worker/output'

export type ValidatedChange = Change & { valid: boolean; reason?: string }

export function validateChanges(sandbox: Sandbox, changes: Change[]): ValidatedChange[] {
  return changes.map((change) => validateOne(sandbox, change))
}

function validateOne(sandbox: Sandbox, change: Change): ValidatedChange {
  let abs: string
  try {
    abs = sandbox.resolve(change.path)
  } catch (err) {
    if (err instanceof SandboxError) return { ...change, valid: false, reason: err.message }
    throw err
  }
  if (change.type === 'full') return { ...change, valid: true }
  if (!fs.existsSync(abs)) {
    return { ...change, valid: false, reason: `Diff target "${change.path}" does not exist` }
  }
  const current = fs.readFileSync(abs, 'utf8')
  const patched = applyPatch(current, change.content)
  if (patched === false) {
    return { ...change, valid: false, reason: `Unified diff does not apply cleanly to "${change.path}" (stale or misaligned hunks)` }
  }
  return { ...change, valid: true }
}

export function invalidReasons(changes: ValidatedChange[]): string[] {
  return changes.filter((c) => !c.valid).map((c) => `invalid patch for ${c.path}: ${c.reason}`)
}
