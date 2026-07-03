import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { outcomesSchema, type ModelEntry, type Registry } from './schema'

export const DEFAULT_ELO = 1000

export const tagRatingSchema = z.object({
  elo: z.number(),
  matches: z.number().int().min(0),
})
export type TagRating = z.infer<typeof tagRatingSchema>

export const modelStateSchema = z.object({
  ratings: z.record(z.string(), tagRatingSchema).default({}),
  outcomes: outcomesSchema.default({ accepted: 0, reworked: 0, rejected: 0 }),
  evalScore: z.number().min(0).max(1).optional(),
  availabilityStrikes: z.number().int().min(0).default(0),
})
export type ModelState = z.infer<typeof modelStateSchema>

export const judgeAgreementSchema = z.object({
  agree: z.number().int().min(0),
  total: z.number().int().min(0),
})
export type JudgeAgreement = z.infer<typeof judgeAgreementSchema>

export const stateSchema = z.object({
  version: z.literal(1),
  models: z.record(z.string(), modelStateSchema),
  judgeAgreement: judgeAgreementSchema.default({ agree: 0, total: 0 }),
})
export type NvState = z.infer<typeof stateSchema>

export function defaultStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.ELODROME_STATE ?? path.join(os.homedir(), '.elodrome', 'state.json')
}

export function getRating(state: NvState, modelId: string, tag: string): TagRating {
  return state.models[modelId]?.ratings[tag] ?? { elo: DEFAULT_ELO, matches: 0 }
}

function seedEntry(entry: ModelEntry): ModelState {
  const { accepted, reworked, rejected } = entry.outcomes
  const total = accepted + reworked + rejected
  const elo = DEFAULT_ELO + 8 * accepted - 4 * reworked - 16 * rejected
  return {
    ratings: total > 0
      ? Object.fromEntries(entry.tags.map((t) => [t, { elo, matches: total }]))
      : {},
    outcomes: { ...entry.outcomes },
    ...(entry.evalScore !== undefined ? { evalScore: entry.evalScore } : {}),
    availabilityStrikes: 0,
  }
}

export function seedFromCatalog(state: NvState, catalog: Registry): NvState {
  const models = { ...state.models }
  for (const entry of catalog.models) {
    if (!models[entry.id]) models[entry.id] = seedEntry(entry)
  }
  return { ...state, models }
}

export function loadState(statePath: string, catalog: Registry): NvState {
  const base: NvState = fs.existsSync(statePath)
    ? stateSchema.parse(JSON.parse(fs.readFileSync(statePath, 'utf8')))
    : { version: 1, models: {}, judgeAgreement: { agree: 0, total: 0 } }
  return seedFromCatalog(base, catalog)
}

export function saveState(statePath: string, state: NvState): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true })
  const tmp = `${statePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
  fs.renameSync(tmp, statePath)
}

const LOCK_STALE_MS = 10_000
const LOCK_RETRIES = 200
const LOCK_WAIT_MS = 25

function lockAgeMs(lockDir: string): number {
  try {
    return Date.now() - fs.statSync(lockDir).mtimeMs
  } catch {
    return 0
  }
}

export async function withStateLock<T>(
  statePath: string,
  catalog: Registry,
  fn: (state: NvState) => { state: NvState; result: T },
): Promise<T> {
  const lockDir = `${statePath}.lock`
  const ownerPath = path.join(lockDir, 'owner')
  fs.mkdirSync(path.dirname(statePath), { recursive: true })
  let token = ''
  for (let i = 0; ; i++) {
    try {
      fs.mkdirSync(lockDir)
      token = `${process.pid}.${crypto.randomBytes(8).toString('hex')}`
      fs.writeFileSync(ownerPath, token)
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      if (i >= LOCK_RETRIES) {
        throw new Error(`Could not acquire state lock ${lockDir} after ${LOCK_RETRIES} attempts`)
      }
      if (lockAgeMs(lockDir) > LOCK_STALE_MS) {
        const reclaimPath = `${lockDir}.reclaim-${crypto.randomBytes(4).toString('hex')}`
        try {
          fs.renameSync(lockDir, reclaimPath)
        } catch {
          // another racer won the reclaim rename; retry mkdir on the next iteration
          continue
        }
        fs.rmSync(reclaimPath, { recursive: true, force: true })
        continue
      }
      await new Promise((r) => setTimeout(r, LOCK_WAIT_MS))
    }
  }
  try {
    const { state, result } = fn(loadState(statePath, catalog))
    saveState(statePath, state)
    return result
  } finally {
    let ownedByUs = false
    try {
      ownedByUs = fs.readFileSync(ownerPath, 'utf8') === token
    } catch {
      // owner file missing: the lock dir was reclaimed by another process; nothing to unwind
      ownedByUs = false
    }
    if (ownedByUs) {
      fs.rmSync(lockDir, { recursive: true, force: true })
    }
  }
}
