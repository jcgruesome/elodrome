import fs from 'node:fs'
import YAML from 'yaml'
import { z } from 'zod'
import { delegate, type DelegateDeps } from '../pipeline/delegate'
import { loadRegistry } from '../registry/registry'
import { capabilityTagSchema, type Registry } from '../registry/schema'

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
  deps: DelegateDeps & { registryPath: string },
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
  writeScore(deps.registryPath, opts.modelId, score)
  return { modelId: opts.modelId, passed, total, score, failures }
}

function writeScore(registryPath: string, modelId: string, score: number): void {
  const registry = loadRegistry(registryPath)
  const updated: Registry = {
    ...registry,
    models: registry.models.map((m) => (m.id === modelId ? { ...m, evalScore: score } : m)),
  }
  fs.writeFileSync(registryPath, YAML.stringify(updated))
}
