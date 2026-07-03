import { describe, expect, it } from 'vitest'
import type { ChatResult } from '../src/nim/client'
import {
  anonymizeEntries, runJudgePanel, scrubModelNames, type ArenaEntry,
} from '../src/arena/judge'

function entry(model: string, summary: string, completionTokens = 10): ArenaEntry {
  return {
    model,
    result: { summary, rationale: `by ${model}`, changes: [{ path: 'a.ts', type: 'full', content: 'x' }] },
    changes: [{ path: 'a.ts', type: 'full', content: 'x', valid: true }],
    stats: { requests: 1, promptTokens: 1, completionTokens },
  }
}

function textReply(content: string): ChatResult {
  return {
    content, toolCalls: [],
    assistantMessage: { role: 'assistant', content },
    usage: { promptTokens: 1, completionTokens: 1 },
  }
}

function scripted(replies: ChatResult[]) {
  let i = 0
  return { chat: async () => { const r = replies[i]; i += 1; if (!r) throw new Error('exhausted'); return r } }
}

const verdict = (ranking: string[], failLabel?: string) => textReply(JSON.stringify({
  ranking,
  verdicts: Object.fromEntries(ranking.map((l) => [l, l === failLabel ? 'fail' : 'pass'])),
  issues: failLabel ? { [failLabel]: ['bug'] } : {},
}))

describe('anonymization', () => {
  it('scrubs model ids and names case-insensitively', () => {
    expect(scrubModelNames('Done by z-ai/glm-5.2 (GLM 5.2)', ['z-ai/glm-5.2', 'GLM 5.2']))
      .toBe('Done by [model] ([model])')
  })

  it('is deterministic for a runId, assigns labels, and caps size', () => {
    const entries = [entry('m/a', 'one'), entry('m/b', 'x'.repeat(30_000))]
    const a1 = anonymizeEntries(entries, 'run_1', ['m/a', 'm/b'])
    const a2 = anonymizeEntries(entries, 'run_1', ['m/a', 'm/b'])
    expect(a1.map((e) => e.model)).toEqual(a2.map((e) => e.model))
    expect(a1.map((e) => e.label)).toEqual(['A', 'B'])
    const big = a1.find((e) => e.model === 'm/b')!
    expect(big.text.length).toBeLessThan(21_000)
    expect(big.text).toContain('[truncated for judging]')
    expect(a1.every((e) => !e.text.includes('m/a') && !e.text.includes('m/b'))).toBe(true)
  })

  it('defensively folds entry model ids into the scrub set even with an empty names list', () => {
    const entries = [entry('m/a', 'one'), entry('m/b', 'two')]
    const anon = anonymizeEntries(entries, 'run_1', [])
    expect(anon.every((e) => !e.text.includes('m/a') && !e.text.includes('m/b'))).toBe(true)
  })
})

describe('runJudgePanel', () => {
  const entries = [entry('m/a', 's1', 5), entry('m/b', 's2', 50)]

  it('aggregates two agreeing judges', async () => {
    const anon = anonymizeEntries(entries, 'run_1', [])
    const [l1, l2] = [anon[0]!.label, anon[1]!.label]
    const panel = await runJudgePanel(
      scripted([verdict([l1, l2]), verdict([l1, l2])]), ['j1', 'j2'], 'task', anon,
    )
    expect(panel.ranking).toEqual([l1, l2])
    expect(panel.agreement).toBe(true)
    expect(panel.judges).toEqual(['j1', 'j2'])
    expect(panel.usage.requests).toBe(2)
  })

  it('breaks rank-sum ties with the first judge ranking', async () => {
    const anon = anonymizeEntries(entries, 'run_1', [])
    const [l1, l2] = [anon[0]!.label, anon[1]!.label]
    const panel = await runJudgePanel(
      scripted([verdict([l2, l1]), verdict([l1, l2])]), ['j1', 'j2'], 'task', anon,
    )
    expect(panel.ranking[0]).toBe(l2) // rank-sums tie; judge j1 said l2 first
    expect(panel.agreement).toBe(false)
  })

  it('drops a judge after two bad replies, fails any-fail verdicts', async () => {
    const anon = anonymizeEntries(entries, 'run_1', [])
    const [l1, l2] = [anon[0]!.label, anon[1]!.label]
    const panel = await runJudgePanel(
      scripted([textReply('nope'), textReply('still nope'), verdict([l1, l2], l1)]),
      ['j1', 'j2'], 'task', anon,
    )
    expect(panel.judges).toEqual(['j2'])
    expect(panel.agreement).toBeNull()
    expect(panel.verdicts[l1]).toBe('fail')
    expect(panel.issues[l1]).toEqual(['bug'])
  })

  it('rejects rankings that are not a permutation of labels', async () => {
    const anon = anonymizeEntries(entries, 'run_1', [])
    const bad = textReply(JSON.stringify({ ranking: ['Z'], verdicts: {}, issues: {} }))
    await expect(runJudgePanel(scripted([bad, bad, bad, bad]), ['j1', 'j2'], 'task', anon))
      .rejects.toThrow(/All judges/)
  })
})
