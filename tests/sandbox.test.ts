import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { Sandbox, SandboxError, validateWorkspace } from '../src/sandbox/sandbox'

let root: string
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-'))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src/app.ts'), 'export {}')
  fs.writeFileSync(path.join(root, '.env'), 'SECRET=x')
  fs.writeFileSync(path.join(root, '.gitignore'), 'dist/\n')
  fs.mkdirSync(path.join(root, 'dist'))
  fs.writeFileSync(path.join(root, 'dist/out.js'), '')
})

describe('validateWorkspace', () => {
  it('accepts the launch dir itself and subdirs', () => {
    expect(validateWorkspace(root, root)).toBe(root)
    expect(validateWorkspace(path.join(root, 'src'), root)).toBe(path.join(root, 'src'))
  })
  it('rejects paths outside the launch dir', () => {
    expect(() => validateWorkspace(os.homedir(), root)).toThrow(SandboxError)
  })
  it('rejects non-directories', () => {
    expect(() => validateWorkspace(path.join(root, 'src/app.ts'), root)).toThrow(SandboxError)
  })
})

describe('Sandbox.resolve', () => {
  it('resolves normal files', () => {
    const sbx = new Sandbox(root)
    // resolve() returns the realpath-canonicalized location (closes a TOCTOU
    // gap — see sandbox.ts), which can differ from the lexical `root` when an
    // ancestor directory is itself a symlink (e.g. macOS's /tmp).
    expect(sbx.resolve('src/app.ts')).toBe(fs.realpathSync(path.join(root, 'src/app.ts')))
  })
  it('blocks escapes', () => {
    const sbx = new Sandbox(root)
    expect(() => sbx.resolve('../outside.txt')).toThrow(SandboxError)
    expect(() => sbx.resolve('/etc/passwd')).toThrow(SandboxError)
  })
  it('blocks denylisted and gitignored paths', () => {
    const sbx = new Sandbox(root)
    for (const p of ['.env', '.env.local', 'keys/server.pem', '.git/config', 'aws/credentials', 'dist/out.js']) {
      expect(() => sbx.resolve(p), p).toThrow(SandboxError)
    }
  })
  it('blocks case-variant denylisted names', () => {
    const sbx = new Sandbox(root)
    for (const p of ['.ENV', 'ID_RSA', 'keys/SERVER.PEM', '.GIT/config', 'AWS/CREDENTIALS', 'id_rsa.backup', 'ID_ED25519.pub']) {
      expect(() => sbx.resolve(p), p).toThrow(SandboxError)
    }
  })
  it('blocks new denylist entries: ssh keys, aws dir, authorized_keys, .netrc, .npmrc, *.key', () => {
    const sbx = new Sandbox(root)
    for (const p of [
      '.ssh/id_ed25519',
      '.ssh/config',
      '.aws/config',
      'authorized_keys',
      '.netrc',
      '.npmrc',
      'server.key',
    ]) {
      expect(() => sbx.resolve(p), p).toThrow(SandboxError)
    }
  })
  it('blocks symlinks inside root that point outside root', () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-outside-'))
    const secretPath = path.join(outsideDir, 'secret.txt')
    fs.writeFileSync(secretPath, 'top secret')

    const linkPath = path.join(root, 'escape-link.txt')
    if (fs.existsSync(linkPath)) fs.unlinkSync(linkPath)
    fs.symlinkSync(secretPath, linkPath)

    const dirLinkPath = path.join(root, 'escape-dir')
    if (fs.existsSync(dirLinkPath)) fs.unlinkSync(dirLinkPath)
    fs.symlinkSync(outsideDir, dirLinkPath)

    const sbx = new Sandbox(root)
    expect(() => sbx.resolve('escape-link.txt')).toThrow(SandboxError)
    expect(() => sbx.resolve('escape-dir/secret.txt')).toThrow(SandboxError)
  })
  it('returns the realpath for symlinks that stay inside root, closing the TOCTOU window', () => {
    // resolve() must hand back the *validated* (symlink-free) location, not
    // the lexical one — otherwise a symlink swapped after validation but
    // before the caller's read/stat could redirect past the check.
    const targetDir = path.join(root, 'real-target')
    fs.mkdirSync(targetDir, { recursive: true })
    fs.writeFileSync(path.join(targetDir, 'inner.txt'), 'safe')

    const linkPath = path.join(root, 'inside-link')
    if (fs.existsSync(linkPath)) fs.unlinkSync(linkPath)
    fs.symlinkSync(targetDir, linkPath)

    const sbx = new Sandbox(root)
    const resolved = sbx.resolve('inside-link/inner.txt')
    expect(resolved).toBe(fs.realpathSync(path.join(targetDir, 'inner.txt')))
    expect(resolved).not.toContain('inside-link')
  })
})
