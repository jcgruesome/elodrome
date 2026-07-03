// Cross-process stress fixture for withStateLock.
// Run via: node --import tsx tests/fixtures/lock-stress.mts <statePath> <iterations>
import fs from 'node:fs'
import type { Registry } from '../../src/registry/schema'
import { loadState, withStateLock } from '../../src/registry/state'

const [, , rawStatePath, rawIterations] = process.argv
if (!rawStatePath || !rawIterations) {
  throw new Error('usage: lock-stress.mts <statePath> <iterations>')
}
const statePath: string = rawStatePath
const iterations = Number.parseInt(rawIterations, 10)

const catalog: Registry = {
  version: 1,
  models: [
    {
      id: 'stress/model',
      name: 'Stress',
      tags: ['code-gen'],
      contextWindow: 1,
      toolCalling: 'reliable',
      outcomes: { accepted: 0, reworked: 0, rejected: 0 },
    },
  ],
}

async function main(): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    await withStateLock(statePath, catalog, (state) => ({
      state: {
        ...state,
        models: {
          ...state.models,
          'stress/model': {
            ...state.models['stress/model']!,
            availabilityStrikes: state.models['stress/model']!.availabilityStrikes + 1,
          },
        },
      },
      result: null,
    }))
  }
  // touch loadState once to ensure the file parses cleanly before exiting
  loadState(statePath, catalog)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
