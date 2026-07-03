import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Command } from 'commander'
import { buildBoardData } from '../board/data'
import { renderBoardHtml } from '../board/render'
import { loadConfig, type Config } from '../config'
import { NimClient } from '../nim/client'
import { delegate } from '../pipeline/delegate'
import { buildLeaderboard, renderLeaderboardMd } from '../registry/leaderboard'
import { defaultRegistryPath, loadRegistry, winRate } from '../registry/registry'
import { capabilityTagSchema, type CapabilityTag } from '../registry/schema'
import { defaultStatePath, loadState } from '../registry/state'

export interface CliDeps {
  config: Config
  registryPath: string
  statePath: string
  client: Pick<NimClient, 'chat'>
  launchDir?: string
  print?: (s: string) => void
}

export function buildCli(deps: CliDeps): Command {
  const print = deps.print ?? ((s: string) => process.stdout.write(`${s}\n`))
  const program = new Command('elodrome').description('Elodrome: NVIDIA NIM model tournaments for Claude Code')

  program.command('models').description('List registry models').action(() => {
    const registry = loadRegistry(deps.registryPath)
    const state = loadState(deps.statePath, registry)
    for (const m of registry.models) {
      const outcomes = state.models[m.id]?.outcomes ?? { accepted: 0, reworked: 0, rejected: 0 }
      print(`${m.id.padEnd(45)} tools=${m.toolCalling.padEnd(10)} win=${winRate(outcomes).toFixed(2)} tags=${m.tags.join(',')}`)
    }
  })

  program.command('run')
    .description('Delegate a task through the full pipeline')
    .requiredOption('--task <task>')
    .requiredOption('--workspace <dir>')
    .option('--profile <tags>', 'comma-separated capability tags', 'code-gen')
    .option('--model <id>')
    .action(async (opts: { task: string; workspace: string; profile: string; model?: string }) => {
      const catalog = loadRegistry(deps.registryPath)
      const taskProfile = opts.profile.split(',').map((t) => capabilityTagSchema.parse(t.trim())) as CapabilityTag[]
      const res = await delegate(
        { config: deps.config, catalog, statePath: deps.statePath, client: deps.client, launchDir: deps.launchDir },
        { task: opts.task, workspace: path.resolve(opts.workspace), taskProfile, model: opts.model },
      )
      print(JSON.stringify(res, null, 2))
    })

  program.command('eval')
    .description('Run an eval suite against one model and record its score')
    .requiredOption('--suite <file>')
    .requiredOption('--workspace <dir>')
    .requiredOption('--model <id>')
    .action(async (opts: { suite: string; workspace: string; model: string }) => {
      const { runEvalSuite } = await import('../eval/harness')
      const catalog = loadRegistry(deps.registryPath)
      const result = await runEvalSuite(
        { config: deps.config, catalog, statePath: deps.statePath, client: deps.client, launchDir: deps.launchDir },
        { suitePath: opts.suite, workspace: path.resolve(opts.workspace), modelId: opts.model },
      )
      print(JSON.stringify(result, null, 2))
    })

  program.command('leaderboard')
    .description('Per-repo model leaderboard (Elo per capability tag)')
    .option('--tag <tag>')
    .option('--md', 'print shareable markdown')
    .action((opts: { tag?: string; md?: boolean }) => {
      const catalog = loadRegistry(deps.registryPath)
      const state = loadState(deps.statePath, catalog)
      const tag = opts.tag ? capabilityTagSchema.parse(opts.tag) : undefined
      const sections = buildLeaderboard(catalog, state, tag)
      if (opts.md) {
        const title = `${path.basename(process.cwd())} — Elodrome leaderboard — ${new Date().toISOString().slice(0, 10)}`
        print(renderLeaderboardMd(sections, title, state.judgeAgreement))
        return
      }
      for (const s of sections) {
        print(`[${s.tag}]`)
        for (const r of s.rows) print(`  ${r.rank}  ${r.id.padEnd(45)} ${Math.round(r.elo)}  ${r.matches}${r.strikes ? `  strikes=${r.strikes}` : ''}`)
      }
    })

  program.command('board')
    .description('Write the Arena match board (ReshapeX-styled HTML) from traces + state')
    .option('--out <path>', 'output file', path.join(os.homedir(), '.nv-agents', 'board.html'))
    .option('--days <n>', 'only include bouts from the last N days')
    .action((opts: { out: string; days?: string }) => {
      const catalog = loadRegistry(deps.registryPath)
      const state = loadState(deps.statePath, catalog)
      const days = opts.days === undefined ? undefined : Number(opts.days)
      if (days !== undefined && (!Number.isFinite(days) || days < 0)) {
        throw new Error(`--days must be a non-negative number, got "${opts.days}"`)
      }
      const data = buildBoardData(deps.config.runsDir, catalog, state, { days })
      const outPath = path.resolve(opts.out)
      fs.mkdirSync(path.dirname(outPath), { recursive: true })
      fs.writeFileSync(outPath, renderBoardHtml(data))
      print(outPath)
    })

  return program
}

const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))
if (isMain) {
  const config = loadConfig()
  const cli = buildCli({
    config,
    registryPath: process.env.ELODROME_REGISTRY ?? defaultRegistryPath(),
    statePath: process.env.ELODROME_STATE ?? defaultStatePath(),
    client: new NimClient(config),
  })
  await cli.parseAsync(process.argv)
}
