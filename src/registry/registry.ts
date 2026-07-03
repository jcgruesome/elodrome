import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import {
  registrySchema, type CapabilityTag, type ModelEntry, type Registry,
} from './schema'

export function defaultRegistryPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'models.yaml')
}

export function loadRegistry(filePath: string): Registry {
  const raw = fs.readFileSync(filePath, 'utf8')
  return registrySchema.parse(YAML.parse(raw))
}

export function winRate(entry: ModelEntry): number {
  const { accepted, reworked, rejected } = entry.outcomes
  const total = accepted + reworked + rejected
  return total === 0 ? 0.5 : accepted / total
}

export interface SelectOptions {
  requireTools?: boolean
  excludeId?: string
}

export function selectModel(
  registry: Registry,
  profile: CapabilityTag[],
  opts: SelectOptions = {},
): ModelEntry {
  const candidates = registry.models
    .filter((m) => profile.every((tag) => m.tags.includes(tag)))
    .filter((m) => (opts.requireTools ? m.toolCalling === 'reliable' : true))
    .filter((m) => m.id !== opts.excludeId)
  const best = [...candidates].sort(
    (a, b) => winRate(b) - winRate(a) || (b.evalScore ?? 0) - (a.evalScore ?? 0),
  )[0]
  if (!best) {
    const available = registry.models.map((m) => `${m.id} [${m.tags.join(',')}]`).join('; ')
    throw new Error(
      `No registry model matches profile [${profile.join(',')}]`
      + `${opts.requireTools ? ' with reliable tool calling' : ''}. Available: ${available}`,
    )
  }
  return best
}

export function recordOutcome(
  filePath: string,
  modelId: string,
  outcome: 'accepted' | 'reworked' | 'rejected',
): void {
  const registry = loadRegistry(filePath)
  const model = registry.models.find((m) => m.id === modelId)
  if (!model) throw new Error(`Model "${modelId}" not in registry ${filePath}`)
  const updated: Registry = {
    ...registry,
    models: registry.models.map((m) => (m.id === modelId
      ? { ...m, outcomes: { ...m.outcomes, [outcome]: m.outcomes[outcome] + 1 } }
      : m)),
  }
  fs.writeFileSync(filePath, YAML.stringify(updated))
}
