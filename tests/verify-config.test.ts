import { describe, expect, it } from 'vitest'
import { parseVerifyConfig, VERIFY_CONFIG_FILENAME } from '../src/verify/config'

describe('parseVerifyConfig', () => {
  it('parses a valid flat command map', () => {
    const cfg = parseVerifyConfig('{"typecheck": "pnpm typecheck", "test": "pnpm test"}')
    expect(cfg).toEqual({ typecheck: 'pnpm typecheck', test: 'pnpm test' })
  })

  it('throws on invalid JSON', () => {
    expect(() => parseVerifyConfig('{not json')).toThrow()
  })

  it('throws when a value is not a string', () => {
    expect(() => parseVerifyConfig('{"typecheck": 1}')).toThrow()
  })

  it('throws when the top level is not an object', () => {
    expect(() => parseVerifyConfig('["pnpm test"]')).toThrow()
  })

  it('exports the expected filename', () => {
    expect(VERIFY_CONFIG_FILENAME).toBe('elodrome.verify.json')
  })
})
