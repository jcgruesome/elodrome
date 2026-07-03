import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import { registrySchema, type Registry } from './schema'

export function defaultRegistryPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'models.yaml')
}

export function loadRegistry(filePath: string): Registry {
  const raw = fs.readFileSync(filePath, 'utf8')
  return registrySchema.parse(YAML.parse(raw))
}

export function winRate(outcomes: { accepted: number; reworked: number; rejected: number }): number {
  const { accepted, reworked, rejected } = outcomes
  const total = accepted + reworked + rejected
  return total === 0 ? 0.5 : accepted / total
}
