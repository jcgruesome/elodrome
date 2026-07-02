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
    expect(sbx.resolve('src/app.ts')).toBe(path.join(root, 'src/app.ts'))
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
})
