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
import { capabilityTagSchema, type CapabilityTag } from '../registry/schema'
import { applyOutcome } from '../arena/elo'
import { buildLeaderboard } from '../registry/leaderboard'
import { defaultStatePath, loadState, withStateLock } from '../registry/state'
import { appendTrace, findRun } from '../trace/trace'

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

export function buildServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: 'nv-agents', version: '0.1.0' })
  const runWorkers = new Map<string, { model: string; tags: string[] }>()

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
      + 'This feeds model win rates used for future routing.',
    inputSchema: {
      run_id: z.string(),
      outcome: z.enum(['accepted', 'reworked', 'rejected']),
    },
  }, async (args) => {
    try {
      const ref = runWorkers.get(args.run_id) ?? findRun(deps.config.runsDir, args.run_id)
      if (!ref) throw new Error(`Unknown run_id "${args.run_id}" — no delegate trace found`)
      const catalog = loadRegistry(deps.registryPath)
      await withStateLock(deps.statePath, catalog, (s) => ({
        state: applyOutcome(s, ref.model, ref.tags as CapabilityTag[], args.outcome), result: null,
      }))
      appendTrace(deps.config.runsDir, {
        kind: 'outcome', runId: args.run_id, model: ref.model, tags: ref.tags, outcome: args.outcome,
      })
      return ok(JSON.stringify({ recorded: true, model: ref.model, outcome: args.outcome }))
    } catch (e) { return err(e) }
  })

  return server
}

const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))
if (isMain) {
  const config = loadConfig()
  const server = buildServer({
    config,
    registryPath: process.env.NVAGENTS_REGISTRY ?? defaultRegistryPath(),
    statePath: process.env.NVAGENTS_STATE ?? defaultStatePath(),
    client: new NimClient(config),
  })
  await server.connect(new StdioServerTransport())
}
