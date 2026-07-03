import fs from 'node:fs'
import path from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { loadConfig, type Config } from '../config'
import { NimClient } from '../nim/client'
import { delegate } from '../pipeline/delegate'
import {
  defaultRegistryPath, loadRegistry, winRate,
} from '../registry/registry'
import { capabilityTagSchema } from '../registry/schema'
import {
  addLearning, applyOutcome, forgetLearnings, type Outcome,
} from '../arena/elo'
import { buildLeaderboard } from '../registry/leaderboard'
import {
  defaultStatePath, learningSchema, loadState, withStateLock,
} from '../registry/state'
import { appendTrace, findRun, hasOutcome } from '../trace/trace'

const MAX_INLINE_CHARS = 20_000

export function formatToolResult(runsDir: string, runId: string, payload: unknown): string {
  const json = JSON.stringify(payload)
  if (json.length <= MAX_INLINE_CHARS) return json
  const dir = path.join(runsDir, 'payloads')
  fs.mkdirSync(dir, { recursive: true })
  const payloadPath = path.join(dir, `${runId}.json`)
  fs.writeFileSync(payloadPath, json)
  const summary = (payload as { summary?: string }).summary
  const status = (payload as { status?: string }).status
  return JSON.stringify({
    runId,
    payloadPath,
    note: `Result was ${json.length} chars; full payload written to payloadPath. Read it from there.`,
    ...(summary ? { summary } : {}),
    ...(status ? { status } : {}),
  })
}

export interface ServerDeps {
  config: Config
  registryPath: string
  statePath: string
  client: Pick<NimClient, 'chat'>
  launchDir?: string
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

function err(e: unknown) {
  return { isError: true, content: [{ type: 'text' as const, text: (e as Error).message }] }
}

// Learning notes are rendered one-bullet-per-line in buildBriefing; strip embedded
// newlines so a note can never inject an extra bullet or break that formatting.
// Callers pass args already validated against the min(8)/max(300) zod bounds, but
// collapsing newlines can shrink the string further — e.g. "abc\n\ncde" is 8 chars
// (passes the input check) but normalizes to "abc cde" (7 chars). Re-validate the
// *normalized* result against the same bounds (learningSchema's own note field, so
// this can never drift out of sync with it) and fail loudly rather than let
// addLearning/saveState persist a note that the next loadState() can't parse.
function normalizeNote(note: string): string {
  const normalized = note.replace(/\s*\n+\s*/g, ' ').trim()
  if (!learningSchema.shape.note.safeParse(normalized).success) {
    throw new Error('learning note became too short after removing newlines — provide more detail')
  }
  return normalized
}

export function buildServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: 'elodrome', version: '0.1.0' })
  const runWorkers = new Map<string, { model: string; tags: string[] }>()
  const reported = new Set<string>()

  server.registerTool('list_models', {
    description: 'List NVIDIA NIM models available for delegation, with capability tags, '
      + 'tool-calling reliability, eval scores, and outcome win rates. Use this to pick a model.',
    inputSchema: {},
  }, async () => {
    try {
      const catalog = loadRegistry(deps.registryPath)
      const state = loadState(deps.statePath, catalog)
      const models = catalog.models.map((m) => {
        const ms = state.models[m.id]
        return {
          id: m.id, name: m.name, tags: m.tags, contextWindow: m.contextWindow,
          toolCalling: m.toolCalling,
          evalScore: ms?.evalScore ?? null,
          winRate: winRate(ms?.outcomes ?? { accepted: 0, reworked: 0, rejected: 0 }),
          ratings: ms?.ratings ?? {},
          availabilityStrikes: ms?.availabilityStrikes ?? 0,
          learnings: (ms?.learnings ?? []).slice(-3).reverse().map((l) => ({ note: l.note, ts: l.ts })),
        }
      })
      return ok(JSON.stringify({ models }))
    } catch (e) { return err(e) }
  })

  server.registerTool('delegate', {
    description: 'Delegate a coding/research task to an NVIDIA NIM worker model. Runs a full '
      + 'pipeline server-side: agentic read-only worker -> cross-model critique -> one revision '
      + 'if needed. Returns proposed changes (diffs/full files) for YOU to review and apply — '
      + 'the worker never writes. After you apply (or reject) the result, call report_outcome.',
    inputSchema: {
      task: z.string().describe('Complete task description with acceptance criteria'),
      workspace: z.string().describe('Absolute path to the workspace dir (must be inside the project)'),
      task_profile: z.array(capabilityTagSchema).describe('Capability tags for model selection, e.g. ["code-gen","fast"]'),
      model: z.string().optional().describe('Registry model id to force a specific worker'),
    },
  }, async (args) => {
    try {
      const catalog = loadRegistry(deps.registryPath)
      const res = await delegate(
        { config: deps.config, catalog, statePath: deps.statePath, client: deps.client, launchDir: deps.launchDir },
        { task: args.task, workspace: args.workspace, taskProfile: args.task_profile, model: args.model },
      )
      runWorkers.set(res.runId, { model: res.workerModel, tags: res.taskProfile })
      return ok(formatToolResult(deps.config.runsDir, res.runId, res))
    } catch (e) { return err(e) }
  })

  server.registerTool('consult', {
    description: 'Get a single-shot second opinion from a specific NIM model. No tools, no '
      + 'pipeline — just the prompt and its reply. Good for design questions and tie-breaking.',
    inputSchema: {
      model: z.string().describe('Registry model id'),
      prompt: z.string(),
    },
  }, async (args) => {
    try {
      const res = await deps.client.chat({
        model: args.model,
        messages: [{ role: 'user', content: args.prompt }],
      })
      return ok(res.content ?? '')
    } catch (e) { return err(e) }
  })

  server.registerTool('leaderboard', {
    description: 'Per-repo model leaderboard: Elo ratings and match counts per capability tag, '
      + 'built from tournament results and outcome reports. Use it to see which models earn '
      + 'their routing.',
    inputSchema: { tag: capabilityTagSchema.optional() },
  }, async (args) => {
    try {
      const catalog = loadRegistry(deps.registryPath)
      const state = loadState(deps.statePath, catalog)
      return ok(JSON.stringify({ sections: buildLeaderboard(catalog, state, args.tag) }))
    } catch (e) { return err(e) }
  })

  server.registerTool('report_outcome', {
    description: 'REQUIRED after every delegate call, once you have reviewed the result: '
      + 'record whether you accepted the output as-is, reworked it, or rejected it. '
      + 'This feeds model win rates used for future routing. '
      + 'For reworked/rejected, ALWAYS pass `learning`: the observed behavioral cause + '
      + 'prescription (never style praise); check the model\'s existing notes in list_models '
      + 'first and refine rather than restate.',
    inputSchema: {
      run_id: z.string(),
      outcome: z.enum(['accepted', 'reworked', 'rejected']),
      learning: z.string().min(8).max(300).optional(),
    },
  }, async (args) => {
    try {
      // Synchronous guard-then-reserve: there is no `await` between the check and the
      // `reported.add`, so two concurrent calls for the same run_id cannot both pass —
      // whichever handler's synchronous prefix runs first reserves the slot before the
      // event loop can start the other's. Everything after this point is genuinely async
      // (lock acquisition, state mutation), so it must not gate the idempotency check.
      if (reported.has(args.run_id) || hasOutcome(deps.config.runsDir, args.run_id)) {
        throw new Error(`Outcome for "${args.run_id}" was already reported`)
      }
      reported.add(args.run_id)
      try {
        const ref = runWorkers.get(args.run_id) ?? findRun(deps.config.runsDir, args.run_id)
        if (!ref) throw new Error(`Unknown run_id "${args.run_id}" — no delegate trace found`)
        const catalog = loadRegistry(deps.registryPath)
        const learning = args.learning ? normalizeNote(args.learning) : undefined
        await withStateLock(deps.statePath, catalog, (s) => {
          let next = applyOutcome(s, ref.model, z.array(capabilityTagSchema).parse(ref.tags), args.outcome as Outcome)
          if (learning) {
            next = addLearning(next, ref.model, {
              ts: new Date().toISOString(), note: learning,
              tags: ref.tags, outcome: args.outcome as Outcome, runId: args.run_id,
            })
          }
          return { state: next, result: null }
        })
        appendTrace(deps.config.runsDir, {
          kind: 'outcome', runId: args.run_id, model: ref.model, tags: ref.tags,
          outcome: args.outcome, ...(learning ? { learning } : {}),
        })
        return ok(JSON.stringify({ recorded: true, model: ref.model, outcome: args.outcome }))
      } catch (e) {
        // Genuine failure (unknown run_id, lock timeout, etc.) — release the reservation so a
        // legitimate retry of the same run_id isn't permanently blocked.
        reported.delete(args.run_id)
        throw e
      }
    } catch (e) { return err(e) }
  })

  server.registerTool('record_learning', {
    description: 'Record or correct a behavioral learning for ANY catalog model (losers, '
      + 'forfeiters, judges) — `note` appends (deduped, 10-cap FIFO), `forget` removes that '
      + "model's notes containing the substring. Learnings become coach's-notes briefings "
      + 'in future matches.',
    inputSchema: {
      model: z.string(),
      note: z.string().min(8).max(300).optional(),
      tags: z.array(capabilityTagSchema).optional(),
      forget: z.string().min(4).optional(),
    },
  }, async (args) => {
    try {
      if (!args.note && !args.forget) throw new Error('Provide note, forget, or both')
      const catalog = loadRegistry(deps.registryPath)
      if (!catalog.models.some((m) => m.id === args.model)) {
        throw new Error(`Model "${args.model}" is not in the catalog. Call list_models.`)
      }
      const note = args.note ? normalizeNote(args.note) : undefined
      const count = await withStateLock(deps.statePath, catalog, (s) => {
        let next = args.forget ? forgetLearnings(s, args.model, args.forget) : s
        if (note) {
          next = addLearning(next, args.model, {
            ts: new Date().toISOString(), note, tags: args.tags ?? [],
          })
        }
        return { state: next, result: next.models[args.model]?.learnings.length ?? 0 }
      })
      appendTrace(deps.config.runsDir, {
        kind: 'learning', model: args.model,
        ...(note ? { note } : {}), ...(args.forget ? { forget: args.forget } : {}),
        tags: args.tags ?? [],
      })
      return ok(JSON.stringify({ recorded: true, model: args.model, learnings: count }))
    } catch (e) { return err(e) }
  })

  return server
}

const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))
if (isMain) {
  const config = loadConfig()
  const server = buildServer({
    config,
    registryPath: process.env.ELODROME_REGISTRY ?? defaultRegistryPath(),
    statePath: process.env.ELODROME_STATE ?? defaultStatePath(),
    client: new NimClient(config),
  })
  await server.connect(new StdioServerTransport())
}
