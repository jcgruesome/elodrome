import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { Sandbox } from '../src/sandbox/sandbox'
import { validateChanges } from '../src/patch/validate'

let sbx: Sandbox
beforeAll(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-'))
  fs.writeFileSync(path.join(root, 'hello.txt'), 'line one\nline two\n')
  sbx = new Sandbox(root)
})

const goodDiff = `--- a/hello.txt
+++ b/hello.txt
@@ -1,2 +1,2 @@
-line one
+line ONE
 line two
`

const staleDiff = `--- a/hello.txt
+++ b/hello.txt
@@ -1,2 +1,2 @@
-completely different content
+something else
 line two
`

describe('validateChanges', () => {
  it('accepts full changes to new and existing paths', () => {
    const [a, b] = validateChanges(sbx, [
      { path: 'hello.txt', type: 'full', content: 'x' },
      { path: 'brand/new.ts', type: 'full', content: 'y' },
    ])
    expect(a?.valid).toBe(true)
    expect(b?.valid).toBe(true)
  })

  it('rejects full changes to denied paths without throwing', () => {
    const [c] = validateChanges(sbx, [{ path: '.env', type: 'full', content: 'x' }])
    expect(c?.valid).toBe(false)
    expect(c?.reason).toMatch(/denied/i)
  })

  it('accepts a diff that applies cleanly', () => {
    const [c] = validateChanges(sbx, [{ path: 'hello.txt', type: 'diff', content: goodDiff }])
    expect(c?.valid).toBe(true)
    expect(fs.readFileSync(path.join(sbx.root, 'hello.txt'), 'utf8')).toContain('line one')
  })

  it('rejects a stale diff and a diff against a missing file', () => {
    const [stale, missing] = validateChanges(sbx, [
      { path: 'hello.txt', type: 'diff', content: staleDiff },
      { path: 'nope.txt', type: 'diff', content: goodDiff },
    ])
    expect(stale?.valid).toBe(false)
    expect(stale?.reason).toMatch(/apply/i)
    expect(missing?.valid).toBe(false)
    expect(missing?.reason).toMatch(/exist/i)
  })
})
