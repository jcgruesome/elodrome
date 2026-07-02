import path from 'node:path'
import { Command } from 'commander'
import { loadConfig, type Config } from '../config'
import { NimClient } from '../nim/client'
import { delegate } from '../pipeline/delegate'
import { defaultRegistryPath, loadRegistry, winRate } from '../registry/registry'
import { capabilityTagSchema, type CapabilityTag } from '../registry/schema'

export interface CliDeps {
  config: Config
  registryPath: string
  client: Pick<NimClient, 'chat'>
  launchDir?: string
  print?: (s: string) => void
}

export function buildCli(deps: CliDeps): Command {
  const print = deps.print ?? ((s: string) => process.stdout.write(`${s}\n`))
  const program = new Command('nva').description('nv-agents: NVIDIA NIM subagents for Claude Code')

  program.command('models').description('List registry models').action(() => {
    const registry = loadRegistry(deps.registryPath)
    for (const m of registry.models) {
      print(`${m.id.padEnd(45)} tools=${m.toolCalling.padEnd(10)} win=${winRate(m).toFixed(2)} tags=${m.tags.join(',')}`)
    }
  })

  program.command('run')
    .description('Delegate a task through the full pipeline')
    .requiredOption('--task <task>')
    .requiredOption('--workspace <dir>')
    .option('--profile <tags>', 'comma-separated capability tags', 'code-gen')
    .option('--model <id>')
    .action(async (opts: { task: string; workspace: string; profile: string; model?: string }) => {
      const registry = loadRegistry(deps.registryPath)
      const taskProfile = opts.profile.split(',').map((t) => capabilityTagSchema.parse(t.trim())) as CapabilityTag[]
      const res = await delegate(
        { config: deps.config, registry, client: deps.client, launchDir: deps.launchDir },
        { task: opts.task, workspace: path.resolve(opts.workspace), taskProfile, model: opts.model },
      )
      print(JSON.stringify(res, null, 2))
    })

  return program
}

const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))
if (isMain) {
  const config = loadConfig()
  const cli = buildCli({
    config,
    registryPath: process.env.NVAGENTS_REGISTRY ?? defaultRegistryPath(),
    client: new NimClient(config),
  })
  await cli.parseAsync(process.argv)
}
