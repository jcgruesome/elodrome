import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { Sandbox, SandboxError } from '../src/sandbox/sandbox'
import { executeWorkerTool, workerToolDefs, SUBMIT_TOOL } from '../src/sandbox/tools'
import { workerResultSchema } from '../src/worker/output'

let sbx: Sandbox
beforeAll(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-'))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src/a.ts'), 'const answer = 42\n')
  fs.writeFileSync(path.join(root, 'src/b.ts'), 'const other = 1\n')
  fs.writeFileSync(path.join(root, '.env'), 'SECRET=x')
  sbx = new Sandbox(root)
})

describe('worker tools', () => {
  it('defines five tools including submit_result', () => {
    const names = (workerToolDefs as Array<{ function: { name: string } }>).map((t) => t.function.name)
    expect(names.sort()).toEqual(['glob', 'grep', 'list_dir', 'read_file', SUBMIT_TOOL].sort())
  })

  it('read_file returns numbered content', async () => {
    const out = await executeWorkerTool(sbx, 'read_file', '{"path":"src/a.ts"}')
    expect(out).toContain('const answer = 42')
  })

  it('read_file refuses denied paths', async () => {
    await expect(executeWorkerTool(sbx, 'read_file', '{"path":".env"}')).rejects.toThrow(SandboxError)
  })

  it('list_dir and glob enumerate files', async () => {
    expect(await executeWorkerTool(sbx, 'list_dir', '{"path":"src"}')).toContain('a.ts')
    expect(await executeWorkerTool(sbx, 'glob', '{"pattern":"**/*.ts"}')).toContain('src/b.ts')
  })

  it('grep finds matches with path:line prefix', async () => {
    const out = await executeWorkerTool(sbx, 'grep', '{"pattern":"answer"}')
    expect(out).toContain('src/a.ts:1:')
  })

  it('glob and grep never surface denied files', async () => {
    expect(await executeWorkerTool(sbx, 'glob', '{"pattern":"**/*"}')).not.toContain('.env')
    expect(await executeWorkerTool(sbx, 'grep', '{"pattern":"SECRET"}')).not.toContain('.env')
  })

  it('rejects unknown tools and malformed args', async () => {
    await expect(executeWorkerTool(sbx, 'write_file', '{}')).rejects.toThrow(/Unknown tool/)
    await expect(executeWorkerTool(sbx, 'read_file', 'not-json')).rejects.toThrow()
  })
})

describe('workerResultSchema', () => {
  it('validates a result payload', () => {
    const parsed = workerResultSchema.parse({
      summary: 's',
      rationale: 'r',
      changes: [{ path: 'src/a.ts', type: 'full', content: 'x' }],
    })
    expect(parsed.changes[0]?.type).toBe('full')
  })
  it('rejects bad change types', () => {
    expect(() => workerResultSchema.parse({ summary: 's', rationale: 'r', changes: [{ path: 'p', type: 'patch', content: '' }] })).toThrow()
  })
})
