import fs from 'node:fs'
import path from 'node:path'
import ignore, { type Ignore } from 'ignore'

export class SandboxError extends Error {}

// Case-insensitive throughout: filesystems like macOS APFS (default config) and
// Windows resolve names case-insensitively, so a denylist that only matches
// lowercase can be bypassed with e.g. resolve('.ENV') or resolve('ID_RSA').
const DENY_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\.[^/]*)?$/i,
  /\.pem$/i,
  /(^|\/)id_[^/]+$/i,
  /(^|\/)\.ssh(\/|$)/i,
  /(^|\/)\.aws(\/|$)/i,
  /(^|\/)authorized_keys$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.npmrc$/i,
  /\.key$/i,
  /credentials/i,
  /secrets/i,
  /(^|\/)\.git(\/|$)/i,
]

/**
 * Resolves the realpath of the deepest ancestor of `p` that currently exists,
 * then rejoins any trailing segments that do not exist yet. This lets callers
 * validate containment against the real (symlink-free) location of a path
 * even when the path itself (or part of it) has not been created yet.
 */
function realpathDeepestExisting(p: string): string {
  let existing = p
  const remainder: string[] = []
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing)
    if (parent === existing) {
      // Reached filesystem root without finding an existing ancestor.
      break
    }
    remainder.unshift(path.basename(existing))
    existing = parent
  }
  const realExisting = fs.realpathSync(existing)
  return remainder.length > 0 ? path.join(realExisting, ...remainder) : realExisting
}

function isWithin(base: string, target: string): boolean {
  return target === base || target.startsWith(base + path.sep)
}

export function validateWorkspace(workspace: string, launchDir = process.cwd()): string {
  const resolved = path.resolve(workspace)
  const base = path.resolve(launchDir)
  if (!isWithin(base, resolved)) {
    throw new SandboxError(`Workspace "${workspace}" is outside the launch directory ${base}`)
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new SandboxError(`Workspace "${workspace}" is not an existing directory`)
  }
  const realBase = fs.realpathSync(base)
  const realResolved = fs.realpathSync(resolved)
  if (!isWithin(realBase, realResolved)) {
    throw new SandboxError(`Workspace "${workspace}" escapes the launch directory ${base} via a symlink`)
  }
  return resolved
}

export class Sandbox {
  // Canonicalized (symlink-free) at construction time so `root` and the
  // real filesystem location are always the same thing. Without this, a
  // symlinked ancestor of the workspace itself (e.g. macOS's /tmp ->
  // /private/tmp) would make root-relative computations elsewhere
  // (list_dir, glob) disagree with the realpath-validated paths resolve()
  // returns below.
  readonly root: string
  private ig: Ignore

  constructor(root: string) {
    this.root = fs.realpathSync(path.resolve(root))
    this.ig = ignore()
    const gitignorePath = path.join(this.root, '.gitignore')
    if (fs.existsSync(gitignorePath)) {
      this.ig.add(fs.readFileSync(gitignorePath, 'utf8'))
    }
  }

  isDenied(relPath: string): boolean {
    const normalized = relPath.split(path.sep).join('/')
    if (DENY_PATTERNS.some((re) => re.test(normalized))) return true
    return normalized !== '' && this.ig.ignores(normalized)
  }

  resolve(relPath: string): string {
    const abs = path.resolve(this.root, relPath)
    if (!isWithin(this.root, abs)) {
      throw new SandboxError(`Path "${relPath}" escapes the workspace`)
    }
    const rel = path.relative(this.root, abs)
    if (this.isDenied(rel)) {
      throw new SandboxError(`Path "${relPath}" is denied (secrets/.git/.gitignore rules)`)
    }

    // Lexical containment above is not enough: a symlink inside the root can
    // point anywhere on disk. Resolve the real (symlink-free) location and
    // re-check both containment and the denylist against it. We return this
    // resolved path (not the lexical `abs`) so callers read/stat the exact
    // location that was validated — otherwise a symlink swapped in between
    // this check and the caller's later filesystem call could redirect the
    // read past the check (TOCTOU).
    const realAbs = realpathDeepestExisting(abs)
    if (!isWithin(this.root, realAbs)) {
      throw new SandboxError(`Path "${relPath}" escapes the workspace via a symlink`)
    }
    const realRel = path.relative(this.root, realAbs)
    if (this.isDenied(realRel)) {
      throw new SandboxError(`Path "${relPath}" is denied (secrets/.git/.gitignore rules)`)
    }

    return realAbs
  }
}
