import fs from 'node:fs'
import path from 'node:path'
import ignore, { type Ignore } from 'ignore'

export class SandboxError extends Error {}

const DENY_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\.[^/]*)?$/,
  /\.pem$/,
  /(^|\/)id_(rsa|ed25519)[^/]*$/,
  /credentials/i,
  /secrets/i,
  /(^|\/)\.git(\/|$)/,
]

export function validateWorkspace(workspace: string, launchDir = process.cwd()): string {
  const resolved = path.resolve(workspace)
  const base = path.resolve(launchDir)
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new SandboxError(`Workspace "${workspace}" is outside the launch directory ${base}`)
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new SandboxError(`Workspace "${workspace}" is not an existing directory`)
  }
  return resolved
}

export class Sandbox {
  readonly root: string
  private ig: Ignore

  constructor(root: string) {
    this.root = path.resolve(root)
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
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) {
      throw new SandboxError(`Path "${relPath}" escapes the workspace`)
    }
    const rel = path.relative(this.root, abs)
    if (this.isDenied(rel)) {
      throw new SandboxError(`Path "${relPath}" is denied (secrets/.git/.gitignore rules)`)
    }
    return abs
  }
}
