import fs from 'node:fs'
import path from 'node:path'
import fg from 'fast-glob'
import { z } from 'zod'
import { Sandbox } from './sandbox'

export const SUBMIT_TOOL = 'submit_result'
const MAX_OUTPUT_CHARS = 8_000
const MAX_GREP_LINES = 200

function fn(name: string, description: string, parameters: object): unknown {
  return { type: 'function', function: { name, description, parameters } }
}

export const workerToolDefs: unknown[] = [
  fn('read_file', 'Read a file from the workspace (read-only).', {
    type: 'object',
    properties: {
      path: { type: 'string' },
      offset: { type: 'number', description: '1-based start line' },
      limit: { type: 'number', description: 'max lines' },
    },
    required: ['path'],
  }),
  fn('list_dir', 'List entries of a workspace directory.', {
    type: 'object', properties: { path: { type: 'string' } }, required: ['path'],
  }),
  fn('glob', 'Find files matching a glob pattern, relative to the workspace root.', {
    type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'],
  }),
  fn('grep', 'Search file contents with a JS regex. Returns path:line: text.', {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      glob: { type: 'string', description: 'restrict to files matching this glob' },
    },
    required: ['pattern'],
  }),
  fn(SUBMIT_TOOL,
    'REQUIRED final call. Submit your result: a summary, your rationale, and proposed '
    + 'changes. Each change is {path, type: "full"|"diff", content}. Use type "full" '
    + '(entire new file content) for new or small files; "diff" (unified diff) for '
    + 'surgical edits to large files.', {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        rationale: { type: 'string' },
        changes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              type: { type: 'string', enum: ['full', 'diff'] },
              content: { type: 'string' },
            },
            required: ['path', 'type', 'content'],
          },
        },
      },
      required: ['summary', 'rationale', 'changes'],
    }),
]

function truncate(s: string): string {
  return s.length > MAX_OUTPUT_CHARS ? `${s.slice(0, MAX_OUTPUT_CHARS)}\n[truncated]` : s
}

async function allowedFiles(sandbox: Sandbox, pattern: string): Promise<string[]> {
  const entries = await fg(pattern, { cwd: sandbox.root, dot: true, onlyFiles: true })
  return entries.filter((rel) => !sandbox.isDenied(rel)).sort()
}

const readArgs = z.object({ path: z.string(), offset: z.number().optional(), limit: z.number().optional() })
const dirArgs = z.object({ path: z.string() })
const globArgs = z.object({ pattern: z.string() })
const grepArgs = z.object({ pattern: z.string(), glob: z.string().optional() })

export async function executeWorkerTool(
  sandbox: Sandbox,
  name: string,
  argsJson: string,
): Promise<string> {
  const args: unknown = JSON.parse(argsJson)
  switch (name) {
    case 'read_file': {
      const { path: p, offset, limit } = readArgs.parse(args)
      const lines = fs.readFileSync(sandbox.resolve(p), 'utf8').split('\n')
      const start = (offset ?? 1) - 1
      const slice = lines.slice(start, limit ? start + limit : undefined)
      return truncate(slice.map((l, i) => `${start + i + 1}\t${l}`).join('\n'))
    }
    case 'list_dir': {
      const { path: p } = dirArgs.parse(args)
      const abs = sandbox.resolve(p)
      const entries = fs.readdirSync(abs, { withFileTypes: true })
        .filter((e) => !sandbox.isDenied(path.relative(sandbox.root, path.join(abs, e.name))))
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      return truncate(entries.sort().join('\n'))
    }
    case 'glob': {
      const { pattern } = globArgs.parse(args)
      return truncate((await allowedFiles(sandbox, pattern)).join('\n'))
    }
    case 'grep': {
      const { pattern, glob: g } = grepArgs.parse(args)
      const re = new RegExp(pattern)
      const hits: string[] = []
      for (const rel of await allowedFiles(sandbox, g ?? '**/*')) {
        const content = fs.readFileSync(path.join(sandbox.root, rel), 'utf8')
        content.split('\n').forEach((line, i) => {
          if (hits.length < MAX_GREP_LINES && re.test(line)) hits.push(`${rel}:${i + 1}: ${line}`)
        })
        if (hits.length >= MAX_GREP_LINES) break
      }
      return truncate(hits.join('\n') || 'No matches.')
    }
    default:
      throw new Error(`Unknown tool "${name}". Available: read_file, list_dir, glob, grep, ${SUBMIT_TOOL}.`)
  }
}
