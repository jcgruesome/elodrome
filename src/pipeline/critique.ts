import { z } from 'zod'
import type { ChatMessage, NimClient } from '../nim/client'
import type { WorkerResult } from '../worker/output'

export const critiqueSchema = z.object({
  verdict: z.enum(['pass', 'fail']),
  issues: z.array(z.string()),
})
export type Critique = z.infer<typeof critiqueSchema>

export async function runCritique(
  client: Pick<NimClient, 'chat'>,
  reviewerModel: string,
  task: string,
  worker: WorkerResult,
): Promise<Critique> {
  const changesText = worker.changes
    .map((c) => `### ${c.path} (${c.type})\n${c.content}`)
    .join('\n\n')
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: 'You are a strict code reviewer. Respond ONLY with JSON: '
        + '{"verdict":"pass"|"fail","issues":["..."]}. Verdict "fail" only for '
        + 'substantive problems (bugs, wrong behavior, missed requirements, security '
        + 'issues) — not style nits.',
    },
    {
      role: 'user',
      content: `Task given to the worker:\n${task}\n\nWorker summary: ${worker.summary}\n`
        + `Worker rationale: ${worker.rationale}\n\nProposed changes:\n${changesText}`,
    },
  ]
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await client.chat({ model: reviewerModel, messages })
    const parsed = extract(res.content ?? '')
    if (parsed) return parsed
    messages.push(res.assistantMessage)
    messages.push({ role: 'user', content: 'That was not valid JSON. Respond ONLY with {"verdict":"pass"|"fail","issues":[...]}.' })
  }
  throw new Error(`Reviewer ${reviewerModel} failed to produce a parseable critique after 2 attempts`)
}

function extract(text: string): Critique | undefined {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return undefined
  try {
    return critiqueSchema.parse(JSON.parse(match[0]))
  } catch {
    return undefined
  }
}
