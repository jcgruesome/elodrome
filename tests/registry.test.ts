import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadRegistry, winRate } from '../src/registry/registry'

const fixture = `
version: 1
models:
  - id: a/coder
    name: Coder A
    tags: [code-gen, fast]
    contextWindow: 128000
    toolCalling: reliable
    evalScore: 0.9
  - id: b/reviewer
    name: Reviewer B
    tags: [review, deep-reasoning]
    contextWindow: 64000
    toolCalling: none
    outcomes: { accepted: 8, reworked: 1, rejected: 1 }
`

function writeFixture(): string {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'reg-')), 'models.yaml')
  fs.writeFileSync(p, fixture)
  return p
}

describe('registry', () => {
  it('loads and validates the fixture', () => {
    const reg = loadRegistry(writeFixture())
    expect(reg.models).toHaveLength(2)
    expect(reg.models[0]?.outcomes).toEqual({ accepted: 0, reworked: 0, rejected: 0 })
  })

  it('rejects invalid schema', () => {
    const p = writeFixture()
    fs.writeFileSync(p, 'version: 2\nmodels: []\n')
    expect(() => loadRegistry(p)).toThrow()
  })

  it('computes win rate with 0.5 default', () => {
    const reg = loadRegistry(writeFixture())
    expect(winRate(reg.models[0]!.outcomes)).toBe(0.5)
    expect(winRate(reg.models[1]!.outcomes)).toBe(0.8)
  })

  it('ships a valid curated registry', () => {
    const reg = loadRegistry(new URL('../src/registry/models.yaml', import.meta.url).pathname)
    expect(reg.models.length).toBeGreaterThanOrEqual(8)
    expect(reg.models.some((m) => m.tags.includes('review'))).toBe(true)
    expect(reg.models.some((m) => m.toolCalling === 'reliable')).toBe(true)
  })
})
