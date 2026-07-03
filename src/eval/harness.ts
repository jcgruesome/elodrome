import fs from 'node:fs'
import YAML from 'yaml'
import { z } from 'zod'
import { delegate, type DelegateDeps } from '../pipeline/delegate'
import { capabilityTagSchema } from '../registry/schema'
import { withStateLock } from '../registry/state'

const suiteSchema = z.object({
  cases: z.array(z.object({
    id: z.string(),
    task: z.string(),
    profile: z.array(capabilityTagSchema),
    check: z.object({ contains: z.string() }),
  })).min(1),
})

export interface EvalResult {
  modelId: string
  passed: number
  total: number
  score: number
  failures: string[]
}

export async function runEvalSuite(
  deps: DelegateDeps,
  opts: { suitePath: string; workspace: string; modelId: string },
): Promise<EvalResult> {
  const suite = suiteSchema.parse(YAML.parse(fs.readFileSync(opts.suitePath, 'utf8')))
  const failures: string[] = []

  for (const testCase of suite.cases) {
    let passedCase = false
    try {
      const res = await delegate(deps, {
        task: testCase.task,
        workspace: opts.workspace,
        taskProfile: testCase.profile,
        model: opts.modelId,
      })
      const haystack = [res.summary, ...res.changes.map((c) => c.content)].join('\n')
      passedCase = res.status === 'ok' && haystack.includes(testCase.check.contains)
    } catch {
      passedCase = false
    }
    if (!passedCase) failures.push(testCase.id)
  }

  const total = suite.cases.length
  const passed = total - failures.length
  const score = passed / total
  await writeScore(deps.statePath, deps.catalog, opts.modelId, score)
  return { modelId: opts.modelId, passed, total, score, failures }
}

async function writeScore(statePath: string, catalog: DelegateDeps['catalog'], modelId: string, score: number): Promise<void> {
  await withStateLock(statePath, catalog, (s) => ({
    state: {
      ...s,
      models: {
        ...s.models,
        [modelId]: { ...s.models[modelId]!, evalScore: score },
      },
    },
    result: null,
  }))
}
