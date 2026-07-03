# Learning Loop & Match Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Post-match learning capture (`report_outcome.learning` + `record_learning`), coach's-notes briefings injected into worker prompts, and a `nva board` generator that renders the ReshapeX match-night page from traces + state.

**Architecture:** Learnings live per-model in the existing lockfile-guarded state (10-cap FIFO, deduped); pure applicators in `src/arena/elo.ts`; tag-aware briefing selection in `src/arena/select.ts` threaded through loop → arena → delegate. The board is a new `src/board/` module: a trace/state joiner (`data.ts`) and a pure HTML renderer (`render.ts`) with ReshapeX tokens baked in, surfaced as a CLI command.

**Tech Stack:** Same as the repo — TypeScript strict ESM via tsx, pnpm, zod, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-03-learning-loop-design.md` — read before starting any task.

**Lane:** `~/.claude/scripts/new-lane.sh new feat learning-loop`, then `pnpm install` and `cp <main-repo>/.env .` inside the lane.

## Global Constraints

- Learnings: `z.string().min(8).max(300)`; per-model cap **10** (FIFO); byte-identical note appends refresh `ts` instead of duplicating; all writes under `withStateLock`.
- Briefings: latest **3** eligible notes (tags intersect the run's profile, untagged always eligible), newest first, scrubbed with `scrubModelNames` against the full catalog name list; injected ONLY into worker system prompts — never judge prompts.
- `report_outcome` idempotency: second call for the same `run_id` throws (in-memory set + trace scan).
- `record_learning`: at least one of `note`/`forget` required; model must exist in the catalog; traced as `kind:'learning'`.
- Board: bouts newest-first capped at **8** (after optional `--days` filter); counters always all-time; corrupt trace lines skipped AND counted; ladders top **5** per tag from state; Sonnet-equiv `$3/M prompt + $15/M completion`, Opus-equiv `$15/M + $75/M`; ALL dynamic text HTML-escaped in the renderer (learnings/summaries are model/orchestrator prose → XSS surface).
- Board render is pure and self-contained (no external requests — artifact CSP); ReshapeX tokens from the 2026-07-03 DS bundle snapshot with a provenance comment.
- Fail fast everywhere except board *trace reading* (reporting layer: skip + count); malformed state still throws. pnpm + vitest; typecheck clean at every task gate; existing 121 tests stay green (updated only where interfaces deliberately change).

## File Structure

```
src/registry/state.ts     Task 1 (modify: learnings schema)
src/arena/elo.ts          Task 1 (modify: addLearning/forgetLearnings)
src/arena/select.ts       Task 2 (modify: buildBriefing)
src/worker/loop.ts        Task 3 (modify: briefing option)
src/arena/arena.ts        Task 3 (modify: briefings threading)
src/pipeline/delegate.ts  Task 3 (modify: build + pass briefings)
src/trace/trace.ts        Task 4 (modify: hasOutcome)
src/mcp/server.ts         Task 4 (modify: learning param, idempotency, record_learning, list_models)
src/board/data.ts         Task 5 (new)
src/board/render.ts       Task 6 (new)
src/cli/index.ts          Task 7 (modify: board command)
CLAUDE.md                 Task 8 (modify: policy rules 3-4)
tests/* mirror source     each task
```

---

### Task 1: Learnings in state + pure applicators

**Files:**
- Modify: `src/registry/state.ts` (learning schema, `LEARNING_CAP`), `src/arena/elo.ts` (applicators)
- Test: extend `tests/state.test.ts`, `tests/elo.test.ts`

**Interfaces:**
- Consumes: existing `modelStateSchema`, `NvState`, `withModel` (private in elo.ts).
- Produces (later tasks rely on):
  - `src/registry/state.ts`: `learningSchema` / `Learning = { ts: string; note: string; tags: string[]; outcome?: 'accepted'|'reworked'|'rejected'; runId?: string }`; `modelStateSchema` gains `learnings: z.array(learningSchema).default([])`; `export const LEARNING_CAP = 10`.
  - `src/arena/elo.ts`: `addLearning(state: NvState, modelId: string, entry: Learning): NvState` (dedupe byte-identical note → remove old entry, append new one at the end; FIFO-cap at `LEARNING_CAP`); `forgetLearnings(state: NvState, modelId: string, substring: string): NvState` (drops learnings whose `note` contains `substring`; unknown model → returns state unchanged).

- [ ] **Step 1: Write the failing tests**

Append to `tests/elo.test.ts` (reuse the existing `empty: NvState` fixture — it needs `judgeAgreement: { agree: 0, total: 0 }` and now compiles with `learnings` defaulting):

```ts
import { addLearning, forgetLearnings } from '../src/arena/elo'
import { LEARNING_CAP, type Learning } from '../src/registry/state'

const note = (n: string, ts = '2026-07-03T00:00:00Z'): Learning => ({
  ts, note: n, tags: ['code-gen'], outcome: 'reworked', runId: 'run_x_00000000',
})

describe('learnings', () => {
  it('appends and caps FIFO at LEARNING_CAP', () => {
    let s = empty
    for (let i = 0; i < LEARNING_CAP + 3; i++) s = addLearning(s, 'm', note(`note number ${i}`))
    const notes = s.models.m!.learnings.map((l) => l.note)
    expect(notes).toHaveLength(LEARNING_CAP)
    expect(notes[0]).toBe('note number 3') // oldest three dropped
    expect(notes.at(-1)).toBe(`note number ${LEARNING_CAP + 2}`)
    expect(empty.models.m).toBeUndefined() // immutability
  })

  it('dedupes byte-identical notes by refreshing to newest', () => {
    let s = addLearning(empty, 'm', note('same note text', '2026-01-01T00:00:00Z'))
    s = addLearning(s, 'm', note('another note here'))
    s = addLearning(s, 'm', note('same note text', '2026-07-03T09:00:00Z'))
    const ls = s.models.m!.learnings
    expect(ls).toHaveLength(2)
    expect(ls.at(-1)!.note).toBe('same note text')
    expect(ls.at(-1)!.ts).toBe('2026-07-03T09:00:00Z')
  })

  it('forgets by substring and ignores unknown models', () => {
    let s = addLearning(empty, 'm', note('fabricates citations under pressure'))
    s = addLearning(s, 'm', note('slow on long files'))
    s = forgetLearnings(s, 'm', 'fabricates')
    expect(s.models.m!.learnings.map((l) => l.note)).toEqual(['slow on long files'])
    expect(forgetLearnings(s, 'nope/nope', 'x')).toEqual(s)
  })
})
```

Append to `tests/state.test.ts`:

```ts
it('round-trips learnings through save/load', () => {
  const p = tmpState()
  const s0 = loadState(p, catalog)
  const withNote = {
    ...s0,
    models: {
      ...s0.models,
      'a/fresh': {
        ...s0.models['a/fresh']!,
        learnings: [{ ts: '2026-07-03T00:00:00Z', note: 'a good learning note', tags: ['code-gen'] }],
      },
    },
  }
  saveState(p, withNote)
  expect(loadState(p, catalog).models['a/fresh']?.learnings[0]?.note).toBe('a good learning note')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run (in the lane): `pnpm vitest run tests/elo.test.ts tests/state.test.ts` — Expected: FAIL (missing exports).

- [ ] **Step 3: Implement**

`src/registry/state.ts` — add after `tagRatingSchema`:

```ts
export const LEARNING_CAP = 10

export const learningSchema = z.object({
  ts: z.string(),
  note: z.string().min(8).max(300),
  tags: z.array(z.string()).default([]),
  outcome: z.enum(['accepted', 'reworked', 'rejected']).optional(),
  runId: z.string().optional(),
})
export type Learning = z.infer<typeof learningSchema>
```

and add to `modelStateSchema`: `learnings: z.array(learningSchema).default([]),`

`src/arena/elo.ts` — add (uses the existing private `withModel`; import `LEARNING_CAP`, `type Learning` from `../registry/state`; `EMPTY_MODEL` gains `learnings: []`):

```ts
export function addLearning(state: NvState, modelId: string, entry: Learning): NvState {
  return withModel(state, modelId, (m) => {
    const kept = m.learnings.filter((l) => l.note !== entry.note)
    return { ...m, learnings: [...kept, entry].slice(-LEARNING_CAP) }
  })
}

export function forgetLearnings(state: NvState, modelId: string, substring: string): NvState {
  if (!state.models[modelId]) return state
  return withModel(state, modelId, (m) => ({
    ...m,
    learnings: m.learnings.filter((l) => !l.note.includes(substring)),
  }))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/elo.test.ts tests/state.test.ts`, then `pnpm test` (fixtures elsewhere must still parse — `learnings` defaults) and `pnpm typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/registry/state.ts src/arena/elo.ts tests/elo.test.ts tests/state.test.ts
git commit -m "feat: per-model learnings with cap, dedupe, and forget"
```

---

### Task 2: Briefing builder

**Files:**
- Modify: `src/arena/select.ts`
- Test: extend `tests/select.test.ts`

**Interfaces:**
- Consumes: `Learning`, `NvState` (Task 1); `scrubModelNames` from `src/arena/judge.ts`; `CapabilityTag`.
- Produces: `buildBriefing(state: NvState, modelId: string, profile: CapabilityTag[], scrubNames: string[]): string | undefined` — latest 3 eligible notes (tags ∩ profile ≠ ∅ OR tags empty), newest first, each scrubbed, formatted as `- <note>` lines joined by `\n`; `undefined` when no eligible notes.

- [ ] **Step 1: Write the failing tests**

Append to `tests/select.test.ts`:

```ts
import { buildBriefing } from '../src/arena/select'
import type { NvState } from '../src/registry/state'

function stateWithLearnings(notes: Array<{ note: string; tags: string[]; ts: string }>): NvState {
  return {
    version: 1,
    judgeAgreement: { agree: 0, total: 0 },
    models: {
      'a/one': {
        ratings: {}, outcomes: { accepted: 0, reworked: 0, rejected: 0 },
        availabilityStrikes: 0,
        learnings: notes.map((n) => ({ ...n })),
      },
    },
  }
}

describe('buildBriefing', () => {
  it('returns latest 3 tag-eligible notes newest first, scrubbed', () => {
    const s = stateWithLearnings([
      { note: 'oldest code note', tags: ['code-gen'], ts: '1' },
      { note: 'research-only note', tags: ['research'], ts: '2' },
      { note: 'untagged note applies anywhere', tags: [], ts: '3' },
      { note: 'newer code note', tags: ['code-gen'], ts: '4' },
      { note: 'mentions a/one by name', tags: ['code-gen'], ts: '5' },
    ])
    const b = buildBriefing(s, 'a/one', ['code-gen'], ['a/one'])
    expect(b).toBeDefined()
    const lines = b!.split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe('- mentions [model] by name')
    expect(lines[1]).toBe('- newer code note')
    expect(lines[2]).toBe('- untagged note applies anywhere')
    expect(b).not.toContain('research-only')
  })

  it('returns undefined for no notes or no eligible notes', () => {
    expect(buildBriefing(stateWithLearnings([]), 'a/one', ['code-gen'], [])).toBeUndefined()
    const onlyResearch = stateWithLearnings([{ note: 'research-only note', tags: ['research'], ts: '1' }])
    expect(buildBriefing(onlyResearch, 'a/one', ['code-gen'], [])).toBeUndefined()
    expect(buildBriefing(onlyResearch, 'missing/model', ['code-gen'], [])).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/select.test.ts` — Expected: FAIL (no export).

- [ ] **Step 3: Implement** — append to `src/arena/select.ts` (add imports: `scrubModelNames` from `./judge`, `type NvState` already imported):

```ts
const BRIEFING_NOTES = 3

export function buildBriefing(
  state: NvState,
  modelId: string,
  profile: CapabilityTag[],
  scrubNames: string[],
): string | undefined {
  const learnings = state.models[modelId]?.learnings ?? []
  const eligible = learnings.filter(
    (l) => l.tags.length === 0 || l.tags.some((t) => (profile as string[]).includes(t)),
  )
  if (eligible.length === 0) return undefined
  return eligible
    .slice(-BRIEFING_NOTES)
    .reverse()
    .map((l) => `- ${scrubModelNames(l.note, scrubNames)}`)
    .join('\n')
}
```

(Learnings are stored oldest→newest — `slice(-3).reverse()` = latest 3, newest first.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/select.test.ts`, `pnpm typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/arena/select.ts tests/select.test.ts
git commit -m "feat: tag-aware coach's-notes briefing builder"
```

---

### Task 3: Briefing injection — loop, arena, delegate

**Files:**
- Modify: `src/worker/loop.ts`, `src/arena/arena.ts`, `src/pipeline/delegate.ts`
- Test: extend `tests/worker-loop.test.ts`, `tests/arena.test.ts`, `tests/delegate.test.ts`

**Interfaces:**
- Consumes: `buildBriefing` (Task 2).
- Produces:
  - `WorkerLoopOptions` gains `briefing?: string`; when present the system message becomes `SYSTEM_PROMPT + '\n\nNotes from your previous work in this repo (address these):\n' + briefing`.
  - `ArenaOptions` gains `briefings?: Record<string, string>` (keyed by model id); `runArena` passes `briefings[m.id]` into each contestant's `runWorkerLoop` AND into `revise()` re-runs (revision keeps the same coaching). Judges never receive briefings.
  - `delegate`: tournament path builds `briefings` via `buildBriefing(state, c.id, req.taskProfile, scrubNames)` per contestant (omitting undefined); single path passes the worker's briefing into its `runWorkerLoop` calls inside `singleDelegate` (add a `briefing?: string` parameter to `singleDelegate`, computed by the callers that already hold `state`).

- [ ] **Step 1: Write the failing tests**

Append to `tests/worker-loop.test.ts` (reuse existing `reply`/`submitArgs`/`scriptedClient` helpers; capture messages with a client wrapper):

```ts
it('appends the briefing to the system prompt', async () => {
  const seen: Array<{ role: string; content: string | null }> = []
  const inner = scriptedClient([
    reply({ toolCalls: [{ id: '1', name: 'submit_result', arguments: submitArgs }] }),
  ])
  const client = {
    chat: async (p: { model: string; messages: Array<{ role: string; content: string | null }> }) => {
      seen.push(...p.messages.filter((m) => m.role === 'system'))
      return inner.chat()
    },
  }
  await runWorkerLoop({ client, model: 'm', task: 't', sandbox: sbx, briefing: '- do not fabricate citations' })
  expect(seen[0]!.content).toContain('Notes from your previous work in this repo (address these):')
  expect(seen[0]!.content).toContain('- do not fabricate citations')
})

it('omits the briefing section when absent', async () => {
  const seen: Array<{ role: string; content: string | null }> = []
  const inner = scriptedClient([
    reply({ toolCalls: [{ id: '1', name: 'submit_result', arguments: submitArgs }] }),
  ])
  const client = {
    chat: async (p: { model: string; messages: Array<{ role: string; content: string | null }> }) => {
      seen.push(...p.messages.filter((m) => m.role === 'system'))
      return inner.chat()
    },
  }
  await runWorkerLoop({ client, model: 'm', task: 't', sandbox: sbx })
  expect(seen[0]!.content).not.toContain('Notes from your previous work')
})
```

(Adapt `scriptedClient`'s call shape if its `chat` takes arguments — pass through.)

Append to `tests/arena.test.ts` (extend `routedClient` to record system prompts per model):

```ts
it('delivers each contestant its own briefing and none to judges', async () => {
  const systems: Record<string, string> = {}
  const base = routedClient({
    'w/x': [submit('from x')],
    'w/y': [submit('from y')],
    'j/1': [verdictFor(['A', 'B'])],
    'j/2': [verdictFor(['A', 'B'])],
  })
  const client = {
    chat: async (p: { model: string; messages: Array<{ role: string; content: string | null }> }) => {
      const sys = p.messages.find((m) => m.role === 'system')
      if (sys?.content) systems[p.model] = (systems[p.model] ?? '') + sys.content
      return base.chat(p)
    },
  }
  await runArena({
    client, config: cfg, sandbox, task: 't', runId: 'run_fixed',
    contestants: [model('w/x'), model('w/y')],
    judgePool: [model('j/1', ['review']), model('j/2', ['review'])],
    scrubNames: [],
    briefings: { 'w/x': '- x-specific coaching note' },
  })
  expect(systems['w/x']).toContain('x-specific coaching note')
  expect(systems['w/y'] ?? '').not.toContain('x-specific coaching note')
  expect(systems['j/1'] ?? '').not.toContain('coaching')
  expect(systems['j/2'] ?? '').not.toContain('coaching')
})
```

(If `routedClient.chat` currently ignores `messages`, extend it to accept and forward the full params object — keep existing queue behavior.)

Append to `tests/delegate.test.ts` (uses `plantState`; extend the planted model state with a learning):

```ts
it('injects the worker model learnings as briefing in single mode', async () => {
  saveState(statePath, {
    version: 1,
    judgeAgreement: { agree: 0, total: 0 },
    models: {
      'w/coder': {
        ratings: { 'code-gen': { elo: 1200, matches: 9 }, review: { elo: 1200, matches: 9 } },
        outcomes: { accepted: 0, reworked: 0, rejected: 0 }, availabilityStrikes: 0,
        learnings: [{ ts: '1', note: 'always run the full suite', tags: ['code-gen'] }],
      },
      'w/coder2': { ratings: { 'code-gen': { elo: 1000, matches: 9 } }, outcomes: { accepted: 0, reworked: 0, rejected: 0 }, availabilityStrikes: 0, learnings: [] },
      'w/coder3': { ratings: { 'code-gen': { elo: 990, matches: 9 } }, outcomes: { accepted: 0, reworked: 0, rejected: 0 }, availabilityStrikes: 0, learnings: [] },
    },
  })
  const systems: string[] = []
  const inner = scripted([submit('v1'), pass])
  const client = {
    calls: inner.calls,
    chat: async (p: { model: string; messages: Array<{ role: string; content: string | null }> }) => {
      const sys = p.messages.find((m) => m.role === 'system')
      if (sys?.content) systems.push(sys.content)
      return inner.chat(p)
    },
  }
  const res = await delegate(
    { config: cfg, catalog, statePath, client, launchDir: workspace },
    { task: 't', workspace, taskProfile: ['code-gen'] },
  )
  expect(res.mode).toBe('single')
  expect(systems.some((s) => s.includes('always run the full suite'))).toBe(true)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/worker-loop.test.ts tests/arena.test.ts tests/delegate.test.ts` — Expected: new tests FAIL.

- [ ] **Step 3: Implement**

`src/worker/loop.ts` — `WorkerLoopOptions` gains `briefing?: string`; in `runWorkerLoop` replace the system message construction:

```ts
  const system = opts.briefing
    ? `${SYSTEM_PROMPT}\n\nNotes from your previous work in this repo (address these):\n${opts.briefing}`
    : SYSTEM_PROMPT
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: opts.task },
  ]
```

`src/arena/arena.ts` — `ArenaOptions` gains `briefings?: Record<string, string>`; contestant loop passes `briefing: opts.briefings?.[m.id]`; `revise()` passes `briefing: opts.briefings?.[entry.model]`. (`singleSurvivor`'s critique path is judge-side — unchanged.)

`src/pipeline/delegate.ts`:
- `singleDelegate(deps, req, sandbox, runId, worker, reviewer, briefing?: string)`; its `attempt` passes `briefing` into `runWorkerLoop`.
- Explicit-model and gate-single call sites compute `const briefing = buildBriefing(state, worker.id, req.taskProfile, scrubNamesOf(deps.catalog))` and pass it.
- Tournament path: `const briefings = Object.fromEntries(decision.contestants.flatMap((c) => { const b = buildBriefing(state, c.id, req.taskProfile, scrubNames); return b ? [[c.id, b]] : [] }))` and pass `briefings` to `runArena`.
- Add a small helper used by both paths: `const scrubNamesOf = (catalog: Registry) => catalog.models.flatMap((m) => [m.id, m.name])` (module-level; replace the existing inline `scrubNames` construction with it).
- Import `buildBriefing` from `../arena/select`.

- [ ] **Step 4: Run all tests**

Run: `pnpm test` and `pnpm typecheck` — all green.

- [ ] **Step 5: Commit**

```bash
git add src/worker/loop.ts src/arena/arena.ts src/pipeline/delegate.ts tests/
git commit -m "feat: inject coach's-notes briefings into worker prompts"
```

---

### Task 4: Capture — report_outcome learning, idempotency, record_learning

**Files:**
- Modify: `src/trace/trace.ts` (`hasOutcome`), `src/mcp/server.ts`
- Test: extend `tests/trace.test.ts`, `tests/mcp-server.test.ts`

**Interfaces:**
- Consumes: `addLearning`, `forgetLearnings`, `applyOutcome` (elo); `learningSchema` bounds; `capabilityTagSchema`.
- Produces:
  - `src/trace/trace.ts`: `hasOutcome(runsDir: string, runId: string): boolean` — true iff any trace record has `kind === 'outcome'` and matching `runId`; false for missing dir.
  - `report_outcome` input gains `learning: z.string().min(8).max(300).optional()`; handler: (1) idempotency — `reported` in-memory `Set<string>` OR `hasOutcome(...)` → throw `` `Outcome for "${run_id}" was already reported` ``; (2) under ONE `withStateLock`: `applyOutcome` then, if `learning`, `addLearning(s, ref.model, { ts: new Date().toISOString(), note: learning, tags: ref.tags, outcome, runId: run_id })`; (3) trace outcome record gains `learning` when present; (4) add `run_id` to `reported`.
  - New tool `record_learning`: input `{ model: z.string(), note: z.string().min(8).max(300).optional(), tags: z.array(capabilityTagSchema).optional(), forget: z.string().min(4).optional() }`; handler throws unless at least one of note/forget; throws if model not in catalog; under one lock applies `forgetLearnings` (if forget) then `addLearning` (if note, `tags ?? []`, no outcome/runId... include `runId` absent); traces `{ kind: 'learning', model, note?, forget?, tags }`; returns `{ recorded: true, model, learnings: <current count> }`.
  - `list_models` models gain `learnings: Array<{ note, ts }>` (latest 3, newest first).
  - Tool descriptions: `report_outcome` description appends the policy sentence: "For reworked/rejected, ALWAYS pass `learning`: the observed behavioral cause + prescription (never style praise); check the model's existing notes in list_models first and refine rather than restate." `record_learning` description: "Record or correct a behavioral learning for ANY catalog model (losers, forfeiters, judges) — `note` appends, `forget` removes notes containing the substring."

- [ ] **Step 1: Write the failing tests**

Append to `tests/trace.test.ts`:

```ts
import { hasOutcome } from '../src/trace/trace'

it('hasOutcome detects outcome records only', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'trace-')), 'runs')
  const runId = newRunId()
  appendTrace(dir, { kind: 'delegate', runId, workerModel: 'a/coder', taskProfile: ['code-gen'] })
  expect(hasOutcome(dir, runId)).toBe(false)
  appendTrace(dir, { kind: 'outcome', runId, outcome: 'accepted' })
  expect(hasOutcome(dir, runId)).toBe(true)
  expect(hasOutcome(path.join(dir, 'missing'), runId)).toBe(false)
})
```

Append to `tests/mcp-server.test.ts` (reuse `connect`/`submit`/`pass`/`textOf` and the planted dominant-champion state):

```ts
it('report_outcome stores a learning and rejects a second report', async () => {
  const mcp = await connect([submit, pass])
  const res = await mcp.callTool({ name: 'delegate', arguments: { task: 't', workspace, task_profile: ['code-gen'] } })
  const { runId } = JSON.parse(textOf(res)) as { runId: string }
  await mcp.callTool({
    name: 'report_outcome',
    arguments: { run_id: runId, outcome: 'reworked', learning: 'left dead code in the helper' },
  })
  const state = loadState(statePath, loadRegistry(registryPath))
  expect(state.models['w/coder']?.learnings.at(-1)?.note).toBe('left dead code in the helper')
  const second = await mcp.callTool({ name: 'report_outcome', arguments: { run_id: runId, outcome: 'accepted' } })
  expect((second as { isError?: boolean }).isError).toBe(true)
  expect(textOf(second)).toMatch(/already reported/)
})

it('record_learning appends to any model and forget removes', async () => {
  const mcp = await connect([])
  await mcp.callTool({
    name: 'record_learning',
    arguments: { model: 'w/coder2', note: 'replies in prose instead of tool calls', tags: ['code-gen'] },
  })
  let state = loadState(statePath, loadRegistry(registryPath))
  expect(state.models['w/coder2']?.learnings[0]?.note).toContain('prose')
  await mcp.callTool({ name: 'record_learning', arguments: { model: 'w/coder2', forget: 'prose' } })
  state = loadState(statePath, loadRegistry(registryPath))
  expect(state.models['w/coder2']?.learnings).toHaveLength(0)
  const bad = await mcp.callTool({ name: 'record_learning', arguments: { model: 'w/coder2' } })
  expect((bad as { isError?: boolean }).isError).toBe(true)
  const unknown = await mcp.callTool({ name: 'record_learning', arguments: { model: 'no/such', note: 'a note long enough' } })
  expect((unknown as { isError?: boolean }).isError).toBe(true)
})

it('list_models exposes latest learnings', async () => {
  const mcp = await connect([])
  await mcp.callTool({ name: 'record_learning', arguments: { model: 'w/coder', note: 'a visible learning note' } })
  const res = await mcp.callTool({ name: 'list_models', arguments: {} })
  const { models } = JSON.parse(textOf(res)) as { models: Array<{ id: string; learnings: Array<{ note: string }> }> }
  expect(models.find((m) => m.id === 'w/coder')?.learnings[0]?.note).toBe('a visible learning note')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/trace.test.ts tests/mcp-server.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement**

`src/trace/trace.ts`:

```ts
export function hasOutcome(runsDir: string, runId: string): boolean {
  if (!fs.existsSync(runsDir)) return false
  for (const file of fs.readdirSync(runsDir).filter((f) => f.endsWith('.jsonl'))) {
    for (const line of fs.readFileSync(path.join(runsDir, file), 'utf8').split('\n')) {
      if (!line.trim()) continue
      const rec = JSON.parse(line) as Record<string, unknown>
      if (rec.kind === 'outcome' && rec.runId === runId) return true
    }
  }
  return false
}
```

`src/mcp/server.ts` — inside `buildServer`, add `const reported = new Set<string>()`; update report_outcome handler:

```ts
if (reported.has(args.run_id) || hasOutcome(deps.config.runsDir, args.run_id)) {
  throw new Error(`Outcome for "${args.run_id}" was already reported`)
}
const ref = runWorkers.get(args.run_id) ?? findRun(deps.config.runsDir, args.run_id)
if (!ref) throw new Error(`Unknown run_id "${args.run_id}" — no delegate trace found`)
const catalog = loadRegistry(deps.registryPath)
await withStateLock(deps.statePath, catalog, (s) => {
  let next = applyOutcome(s, ref.model, ref.tags as CapabilityTag[], args.outcome as Outcome)
  if (args.learning) {
    next = addLearning(next, ref.model, {
      ts: new Date().toISOString(), note: args.learning,
      tags: ref.tags, outcome: args.outcome as Outcome, runId: args.run_id,
    })
  }
  return { state: next, result: null }
})
reported.add(args.run_id)
appendTrace(deps.config.runsDir, {
  kind: 'outcome', runId: args.run_id, model: ref.model, tags: ref.tags,
  outcome: args.outcome, ...(args.learning ? { learning: args.learning } : {}),
})
return ok(JSON.stringify({ recorded: true, model: ref.model, outcome: args.outcome }))
```

Register `record_learning` after `report_outcome` (imports: `addLearning`, `forgetLearnings` from `../arena/elo`):

```ts
server.registerTool('record_learning', {
  description: 'Record or correct a behavioral learning for ANY catalog model (losers, '
    + 'forfeiters, judges) — `note` appends (deduped, 10-cap FIFO), `forget` removes that '
    + "model's notes containing the substring. Learnings become coach's-notes briefings "
    + 'in future matches.',
  inputSchema: {
    model: z.string(),
    note: z.string().min(8).max(300).optional(),
    tags: z.array(capabilityTagSchema).optional(),
    forget: z.string().min(4).optional(),
  },
}, async (args) => {
  try {
    if (!args.note && !args.forget) throw new Error('Provide note, forget, or both')
    const catalog = loadRegistry(deps.registryPath)
    if (!catalog.models.some((m) => m.id === args.model)) {
      throw new Error(`Model "${args.model}" is not in the catalog. Call list_models.`)
    }
    const count = await withStateLock(deps.statePath, catalog, (s) => {
      let next = args.forget ? forgetLearnings(s, args.model, args.forget) : s
      if (args.note) {
        next = addLearning(next, args.model, {
          ts: new Date().toISOString(), note: args.note, tags: args.tags ?? [],
        })
      }
      return { state: next, result: next.models[args.model]?.learnings.length ?? 0 }
    })
    appendTrace(deps.config.runsDir, {
      kind: 'learning', model: args.model,
      ...(args.note ? { note: args.note } : {}), ...(args.forget ? { forget: args.forget } : {}),
      tags: args.tags ?? [],
    })
    return ok(JSON.stringify({ recorded: true, model: args.model, learnings: count }))
  } catch (e) { return err(e) }
})
```

`list_models` model mapping gains:

```ts
learnings: (ms?.learnings ?? []).slice(-3).reverse().map((l) => ({ note: l.note, ts: l.ts })),
```

Append the policy sentence to the `report_outcome` description (exact text in Interfaces above).

- [ ] **Step 4: Run all tests**

Run: `pnpm test` and `pnpm typecheck` — all green.

- [ ] **Step 5: Commit**

```bash
git add src/trace/trace.ts src/mcp/server.ts tests/trace.test.ts tests/mcp-server.test.ts
git commit -m "feat: learning capture with idempotent outcomes and record_learning tool"
```

---

### Task 5: Board data builder

**Files:**
- Create: `src/board/data.ts`
- Test: `tests/board-data.test.ts`

**Interfaces:**
- Consumes: `Registry`, `NvState`, `winRate` (registry); trace JSONL shapes written by `delegate`/`report_outcome`/`record_learning`.
- Produces (Task 6/7 rely on):

```ts
export interface BoutRanking { model: string; place: number | null; forfeit?: string; forfeitReason?: string; delta?: number }
export interface Bout {
  runId: string; ts: string; mode: 'tournament' | 'single'; status: string
  taskProfile: string[]; workerModel: string; judges: string[]
  agreement: boolean | null; revised: boolean
  ranking: BoutRanking[]
  requests: number; promptTokens: number; completionTokens: number
  outcome?: 'accepted' | 'reworked' | 'rejected'; learning?: string
}
export interface BoardData {
  generatedAt: string; repo: string
  bouts: Bout[]
  counters: { runs: number; tournaments: number; singles: number; aborted: number; requests: number; promptTokens: number; completionTokens: number; sonnetEquivUsd: number; opusEquivUsd: number }
  ladders: Array<{ tag: string; rows: Array<{ rank: number; id: string; elo: number; matches: number }> }>
  record: { accepted: number; reworked: number; rejected: number }
  scouting: Array<{ model: string; note: string; ts: string }>
  judgeAgreement: { agree: number; total: number }
  corruptLines: number
}
export function buildBoardData(runsDir: string, catalog: Registry, state: NvState, opts?: { days?: number; repo?: string }): BoardData
```

- Behavior: reads every `*.jsonl` in `runsDir` (missing dir → empty data, zero counters); per line `try { JSON.parse } catch { corruptLines++ }`; joins `kind:'outcome'` onto the bout with the same `runId`; bouts = `kind:'tournament' | 'delegate'` records mapped to `Bout` (single delegates get a 2-row ranking: worker place 1 with no delta; tournament rows merge `eloDeltas[model]` as `delta`)… single delegates get `ranking: [{ model: workerModel, place: 1 }]`. `--days` filters bouts by `ts >= now - days*86400e3`; then newest-first; cap 8. Counters are ALL-TIME (unfiltered): runs/tournaments/singles/aborted counts, requests/prompt/completion sums over non-aborted+aborted alike, `sonnetEquivUsd = prompt/1e6*3 + completion/1e6*15`, `opusEquivUsd = prompt/1e6*15 + completion/1e6*75` (round to cents). Ladders: for each catalog tag with ≥1 rated model — top 5 by elo desc then id. Record: counts of outcome trace records by verdict. Scouting: each model's LAST learning from state (models with none omitted), sorted by ts desc. `repo` defaults to `path.basename(process.cwd())`.

- [ ] **Step 1: Write the failing tests**

`tests/board-data.test.ts`:

```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildBoardData } from '../src/board/data'
import type { Registry } from '../src/registry/schema'
import type { NvState } from '../src/registry/state'

const catalog: Registry = {
  version: 1,
  models: [
    { id: 'a/x', name: 'X', tags: ['code-gen'], contextWindow: 1, toolCalling: 'reliable', outcomes: { accepted: 0, reworked: 0, rejected: 0 } },
    { id: 'b/y', name: 'Y', tags: ['code-gen', 'review'], contextWindow: 1, toolCalling: 'reliable', outcomes: { accepted: 0, reworked: 0, rejected: 0 } },
  ],
}

const state: NvState = {
  version: 1,
  judgeAgreement: { agree: 1, total: 2 },
  models: {
    'a/x': {
      ratings: { 'code-gen': { elo: 1016, matches: 2 } },
      outcomes: { accepted: 0, reworked: 0, rejected: 0 }, availabilityStrikes: 0,
      learnings: [{ ts: '2026-07-03T01:00:00Z', note: 'fabricates when under-reading', tags: [] }],
    },
    'b/y': { ratings: { 'code-gen': { elo: 984, matches: 2 } }, outcomes: { accepted: 0, reworked: 0, rejected: 0 }, availabilityStrikes: 1, learnings: [] },
  },
}

function writeTraces(lines: unknown[]): string {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'board-')), 'runs')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, '2026-07-03.jsonl'),
    lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n')
  return dir
}

const tournament = {
  ts: '2026-07-03T02:00:00Z', kind: 'tournament', runId: 'run_a_00000001', status: 'ok',
  taskProfile: ['code-gen'], workerModel: 'a/x', judges: ['b/y'],
  contestants: ['a/x', 'b/y'], agreement: true, revised: false,
  ranking: [{ model: 'a/x', place: 1 }, { model: 'b/y', place: 2 }],
  requests: 4, promptTokens: 1000, completionTokens: 200,
  eloDeltas: { 'a/x': 16, 'b/y': -16 }, changeCount: 1,
}

describe('buildBoardData', () => {
  it('joins bouts with outcomes and merges deltas', () => {
    const dir = writeTraces([
      tournament,
      { ts: '2026-07-03T02:10:00Z', kind: 'outcome', runId: 'run_a_00000001', outcome: 'reworked', learning: 'missed an edge case' },
      { ts: '2026-07-03T03:00:00Z', kind: 'delegate', runId: 'run_b_00000002', status: 'ok', taskProfile: ['code-gen'], workerModel: 'b/y', reviewerModel: 'a/x', revised: false, requests: 2, promptTokens: 500, completionTokens: 100 },
      'this line is not json{{{',
      { ts: '2026-07-03T04:00:00Z', kind: 'tournament', runId: 'run_c_00000003', status: 'aborted', taskProfile: ['code-gen'], contestants: ['a/x', 'b/y'], forfeits: [{ model: 'a/x', kind: 'no_contest', reason: 'down' }] },
    ])
    const d = buildBoardData(dir, catalog, state, { repo: 'test-repo' })
    expect(d.bouts).toHaveLength(2) // aborted excluded from bout cards
    expect(d.bouts[0]!.runId).toBe('run_b_00000002') // newest first
    const t = d.bouts[1]!
    expect(t.outcome).toBe('reworked')
    expect(t.learning).toBe('missed an edge case')
    expect(t.ranking.find((r) => r.model === 'a/x')?.delta).toBe(16)
    expect(d.counters).toMatchObject({ runs: 3, tournaments: 2, singles: 1, aborted: 1, requests: 6, promptTokens: 1500, completionTokens: 300 })
    expect(d.counters.sonnetEquivUsd).toBeCloseTo(1500 / 1e6 * 3 + 300 / 1e6 * 15, 4)
    expect(d.corruptLines).toBe(1)
    expect(d.record).toEqual({ accepted: 0, reworked: 1, rejected: 0 })
    expect(d.ladders.find((l) => l.tag === 'code-gen')!.rows[0]).toMatchObject({ rank: 1, id: 'a/x', elo: 1016 })
    expect(d.scouting[0]).toMatchObject({ model: 'a/x', note: 'fabricates when under-reading' })
    expect(d.judgeAgreement).toEqual({ agree: 1, total: 2 })
    expect(d.repo).toBe('test-repo')
  })

  it('handles a missing runs dir and days filter', () => {
    const empty = buildBoardData('/nonexistent/nowhere', catalog, state)
    expect(empty.bouts).toEqual([])
    expect(empty.counters.runs).toBe(0)
    const dir = writeTraces([tournament])
    const filtered = buildBoardData(dir, catalog, state, { days: 0 })
    expect(filtered.bouts).toEqual([]) // ts older than a 0-day window
    expect(filtered.counters.runs).toBe(1) // counters stay all-time
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/board-data.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/board/data.ts`**

```ts
import fs from 'node:fs'
import path from 'node:path'
import type { Registry } from '../registry/schema'
import type { NvState } from '../registry/state'

export interface BoutRanking {
  model: string
  place: number | null
  forfeit?: string
  forfeitReason?: string
  delta?: number
}

export interface Bout {
  runId: string
  ts: string
  mode: 'tournament' | 'single'
  status: string
  taskProfile: string[]
  workerModel: string
  judges: string[]
  agreement: boolean | null
  revised: boolean
  ranking: BoutRanking[]
  requests: number
  promptTokens: number
  completionTokens: number
  outcome?: 'accepted' | 'reworked' | 'rejected'
  learning?: string
}

export interface BoardData {
  generatedAt: string
  repo: string
  bouts: Bout[]
  counters: {
    runs: number; tournaments: number; singles: number; aborted: number
    requests: number; promptTokens: number; completionTokens: number
    sonnetEquivUsd: number; opusEquivUsd: number
  }
  ladders: Array<{ tag: string; rows: Array<{ rank: number; id: string; elo: number; matches: number }> }>
  record: { accepted: number; reworked: number; rejected: number }
  scouting: Array<{ model: string; note: string; ts: string }>
  judgeAgreement: { agree: number; total: number }
  corruptLines: number
}

const MAX_BOUTS = 8

type Rec = Record<string, unknown>

function readRecords(runsDir: string): { records: Rec[]; corruptLines: number } {
  if (!fs.existsSync(runsDir)) return { records: [], corruptLines: 0 }
  const records: Rec[] = []
  let corruptLines = 0
  for (const file of fs.readdirSync(runsDir).filter((f) => f.endsWith('.jsonl')).sort()) {
    for (const line of fs.readFileSync(path.join(runsDir, file), 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        records.push(JSON.parse(line) as Rec)
      } catch {
        corruptLines += 1
      }
    }
  }
  return { records, corruptLines }
}

function toBout(rec: Rec, outcomes: Map<string, Rec>): Bout {
  const deltas = (rec.eloDeltas ?? {}) as Record<string, number>
  const ranking: BoutRanking[] = rec.kind === 'tournament'
    ? ((rec.ranking ?? []) as BoutRanking[]).map((r) => ({ ...r, delta: deltas[r.model] }))
    : [{ model: rec.workerModel as string, place: 1 }]
  const outcome = outcomes.get(rec.runId as string)
  return {
    runId: rec.runId as string,
    ts: (rec.ts as string) ?? '',
    mode: rec.kind === 'tournament' ? 'tournament' : 'single',
    status: (rec.status as string) ?? 'ok',
    taskProfile: (rec.taskProfile as string[]) ?? [],
    workerModel: (rec.workerModel as string) ?? '',
    judges: (rec.judges as string[]) ?? [(rec.reviewerModel as string) ?? ''].filter(Boolean),
    agreement: (rec.agreement as boolean | null) ?? null,
    revised: Boolean(rec.revised),
    ranking,
    requests: (rec.requests as number) ?? 0,
    promptTokens: (rec.promptTokens as number) ?? 0,
    completionTokens: (rec.completionTokens as number) ?? 0,
    ...(outcome ? { outcome: outcome.outcome as Bout['outcome'] } : {}),
    ...(outcome?.learning ? { learning: outcome.learning as string } : {}),
  }
}

export function buildBoardData(
  runsDir: string,
  catalog: Registry,
  state: NvState,
  opts: { days?: number; repo?: string } = {},
): BoardData {
  const { records, corruptLines } = readRecords(runsDir)
  const outcomes = new Map(records.filter((r) => r.kind === 'outcome').map((r) => [r.runId as string, r]))
  const runs = records.filter((r) => r.kind === 'tournament' || r.kind === 'delegate')
  const completed = runs.filter((r) => r.status !== 'aborted')

  const cutoff = opts.days !== undefined ? Date.now() - opts.days * 86_400_000 : undefined
  const bouts = completed
    .filter((r) => cutoff === undefined || Date.parse((r.ts as string) ?? '') >= cutoff)
    .map((r) => toBout(r, outcomes))
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, MAX_BOUTS)

  const sum = (k: string) => runs.reduce((acc, r) => acc + ((r[k] as number) ?? 0), 0)
  const promptTokens = sum('promptTokens')
  const completionTokens = sum('completionTokens')
  const counters = {
    runs: runs.length,
    tournaments: runs.filter((r) => r.kind === 'tournament').length,
    singles: runs.filter((r) => r.kind === 'delegate').length,
    aborted: runs.filter((r) => r.status === 'aborted').length,
    requests: sum('requests'),
    promptTokens,
    completionTokens,
    sonnetEquivUsd: Math.round((promptTokens / 1e6 * 3 + completionTokens / 1e6 * 15) * 100) / 100,
    opusEquivUsd: Math.round((promptTokens / 1e6 * 15 + completionTokens / 1e6 * 75) * 100) / 100,
  }

  const tags = [...new Set(catalog.models.flatMap((m) => m.tags))].sort()
  const ladders = tags
    .map((tag) => ({
      tag,
      rows: catalog.models
        .map((m) => ({ m, rating: state.models[m.id]?.ratings[tag] }))
        .filter((x): x is { m: typeof x.m; rating: NonNullable<typeof x.rating> } => x.rating !== undefined)
        .sort((a, b) => b.rating.elo - a.rating.elo || a.m.id.localeCompare(b.m.id))
        .slice(0, 5)
        .map((x, i) => ({ rank: i + 1, id: x.m.id, elo: x.rating.elo, matches: x.rating.matches })),
    }))
    .filter((l) => l.rows.length > 0)

  const record = { accepted: 0, reworked: 0, rejected: 0 }
  for (const o of outcomes.values()) {
    const v = o.outcome as keyof typeof record
    if (v in record) record[v] += 1
  }

  const scouting = Object.entries(state.models)
    .flatMap(([model, ms]) => {
      const last = ms.learnings.at(-1)
      return last ? [{ model, note: last.note, ts: last.ts }] : []
    })
    .sort((a, b) => b.ts.localeCompare(a.ts))

  return {
    generatedAt: new Date().toISOString(),
    repo: opts.repo ?? path.basename(process.cwd()),
    bouts,
    counters,
    ladders,
    record,
    scouting,
    judgeAgreement: state.judgeAgreement,
    corruptLines,
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/board-data.test.ts`, then `pnpm typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/board/data.ts tests/board-data.test.ts
git commit -m "feat: board data builder joining traces, outcomes, and state"
```

---

### Task 6: Board renderer (ReshapeX template)

**Files:**
- Create: `src/board/render.ts`
- Test: `tests/board-render.test.ts`

**Interfaces:**
- Consumes: `BoardData`, `Bout` (Task 5).
- Produces: `renderBoardHtml(data: BoardData): string` — pure; self-contained HTML (no `<html>/<head>/<body>` wrapper — artifact-compatible fragment with `<title>` first); `escapeHtml(s: string): string` (module-private but load-bearing: EVERY dynamic string — notes, summaries, model ids, reasons — passes through it).

Template requirements (content assertions in tests): `<title>NV-AGENTS ARENA` first line; ReshapeX token block with provenance comment `<!-- ReshapeX app-ui tokens — DS bundle snapshot 2026-07-03 -->` and the exact values `#0D1117`, `#1C2128`, `#73B400`, `#FF006E`, `#00D9FF`, `"Plus Jakarta Sans"`, `"JetBrains Mono"`, radii `8px`/`12px`, transition `200ms cubic-bezier(.4,0,.2,1)`; light theme via `@media (prefers-color-scheme: light)` AND `[data-theme="light"]` / `[data-theme="dark"]` overrides; per bout: mode + profile header, ranked rows (champion row class `champ`, forfeits with reason, delta with `+`/`−` and classes `up`/`down`/`flat`), judges strip with `Unanimous`/`Split`/`Solo panel` badge, outcome pill (accepted/reworked/rejected), learning note rendered when present (class `learning-note`), rejected outcome ⇒ bout gets class `inquiry` and a `Stewards' inquiry` badge; counters section (tokens, requests, `$` equivalents, `$0.00` paid); ladders; scouting report section (class `scouting`); footer with provenance split sentence and — when `corruptLines > 0` — `<b>N corrupt trace line(s) skipped.</b>`; judge agreement `X% (k/n panels)` when `total > 0`.

- [ ] **Step 1: Write the failing tests**

`tests/board-render.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { renderBoardHtml } from '../src/board/render'
import type { BoardData } from '../src/board/data'

const data: BoardData = {
  generatedAt: '2026-07-03T05:00:00Z',
  repo: 'test-repo',
  bouts: [{
    runId: 'run_a_00000001', ts: '2026-07-03T02:00:00Z', mode: 'tournament', status: 'ok',
    taskProfile: ['code-gen'], workerModel: 'a/x', judges: ['b/y'], agreement: false, revised: false,
    ranking: [
      { model: 'a/x', place: 1, delta: 16 },
      { model: 'b/y', place: 2, delta: -16 },
      { model: 'c/z', place: null, forfeit: 'no_contest', forfeitReason: 'HTTP 503 <down>' },
    ],
    requests: 4, promptTokens: 1000, completionTokens: 200,
    outcome: 'rejected', learning: 'fabricated <script>alert(1)</script> citations',
  }],
  counters: { runs: 3, tournaments: 2, singles: 1, aborted: 1, requests: 6, promptTokens: 1500, completionTokens: 300, sonnetEquivUsd: 0.01, opusEquivUsd: 0.05 },
  ladders: [{ tag: 'code-gen', rows: [{ rank: 1, id: 'a/x', elo: 1016.4, matches: 2 }] }],
  record: { accepted: 1, reworked: 2, rejected: 1 },
  scouting: [{ model: 'a/x', note: 'reads too little before writing', ts: '2026-07-03T01:00:00Z' }],
  judgeAgreement: { agree: 1, total: 2 },
  corruptLines: 1,
}

describe('renderBoardHtml', () => {
  const html = renderBoardHtml(data)

  it('is a self-contained ReshapeX-tokened page', () => {
    expect(html.startsWith('<title>NV-AGENTS ARENA')).toBe(true)
    expect(html).toContain('ReshapeX app-ui tokens — DS bundle snapshot 2026-07-03')
    for (const v of ['#0D1117', '#1C2128', '#73B400', '#FF006E', 'Plus Jakarta Sans', 'JetBrains Mono']) {
      expect(html).toContain(v)
    }
    expect(html).toContain('prefers-color-scheme: light')
    expect(html).toContain('[data-theme="dark"]')
    expect(html).toContain('[data-theme="light"]')
    expect(html).not.toContain('http://')
    expect(html).not.toContain('https://')
  })

  it('renders bouts with DQ styling, deltas, forfeits, and escaped text', () => {
    expect(html).toContain('class="bout inquiry"')
    expect(html).toContain("Stewards' inquiry")
    expect(html).toContain('+16')
    expect(html).toContain('−16')
    expect(html).toContain('no_contest')
    expect(html).toContain('HTTP 503 &lt;down&gt;')
    expect(html).toContain('fabricated &lt;script&gt;alert(1)&lt;/script&gt; citations')
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('Split')
  })

  it('renders counters, ladders, scouting, record, and footer diagnostics', () => {
    expect(html).toContain('1,500')          // formatted prompt tokens
    expect(html).toContain('$0.01')
    expect(html).toContain('$0.05')
    expect(html).toContain('$0.00')
    expect(html).toContain('| 1016')          // ladder elo rounded — or row markup; assert '1016'
    expect(html).toContain('reads too little before writing')
    expect(html).toContain('1 accepted')
    expect(html).toContain('2 reworked')
    expect(html).toContain('1 rejected')
    expect(html).toContain('50% (1/2 panels)')
    expect(html).toContain('1 corrupt trace line')
  })
})
```

(The `'| 1016'` assertion: adjust to plain `'1016'` if the ladder markup differs — the number must appear rounded.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/board-render.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/board/render.ts`**

Structure (write the full file; the CSS token block is the artifact template the repo's maintainer already approved — reproduce it exactly as below):

```ts
import type { BoardData, Bout, BoutRanking } from './data'

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

const fmt = (n: number) => n.toLocaleString('en-US')
const usd = (n: number) => `$${n.toFixed(2)}`

function deltaHtml(r: BoutRanking): string {
  if (r.delta === undefined || r.delta === 0) return '<span class="delta flat">±0</span>'
  const cls = r.delta > 0 ? 'up' : 'down'
  const sign = r.delta > 0 ? '+' : '−'
  return `<span class="delta ${cls}">${sign}${Math.round(Math.abs(r.delta))}</span>`
}

function rowHtml(r: BoutRanking, champ: boolean): string {
  const tale = r.forfeit
    ? `<span class="tale forfeit">${escapeHtml(r.forfeit)} — ${escapeHtml(r.forfeitReason ?? '')}</span>`
    : '<span class="tale"></span>'
  return `<div class="row${champ ? ' champ' : ''}"><span class="seed">${r.place ?? '–'}</span>`
    + `<span class="fighter">${escapeHtml(r.model)}</span>${tale}${deltaHtml(r)}</div>`
}

function agreementBadge(b: Bout): string {
  if (b.agreement === true) return '<span class="badge unan">Unanimous</span>'
  if (b.agreement === false) return '<span class="badge split">Split</span>'
  return '<span class="badge solo">Solo panel</span>'
}

function boutHtml(b: Bout): string {
  const dq = b.outcome === 'rejected'
  const outcomePill = b.outcome
    ? `<span class="badge outcome-${b.outcome}">${b.outcome}</span>`
    : '<span class="badge solo">unreported</span>'
  const learning = b.learning
    ? `<p class="learning-note">Learning: ${escapeHtml(b.learning)}</p>`
    : ''
  return `<div class="bout${dq ? ' inquiry' : ''}">
  <div class="bout-head"><span>${b.mode} · <b>${escapeHtml(b.taskProfile.join(', '))}</b></span>`
    + `<span>${escapeHtml(b.runId)}${dq ? " — <b>Stewards' inquiry</b>" : ''}</span></div>
  <div class="card">
    ${b.ranking.map((r, i) => rowHtml(r, i === 0 && !r.forfeit)).join('\n    ')}
    <div class="judges">JUDGES&nbsp; ${b.judges.map(escapeHtml).join(' · ')} ${agreementBadge(b)} ${outcomePill}</div>
    ${learning}
  </div>
</div>`
}

export function renderBoardHtml(d: BoardData): string {
  const agreementLine = d.judgeAgreement.total > 0
    ? `Judge agreement: ${Math.round((d.judgeAgreement.agree / d.judgeAgreement.total) * 100)}% (${d.judgeAgreement.agree}/${d.judgeAgreement.total} panels)`
    : ''
  const corrupt = d.corruptLines > 0
    ? ` <b>${d.corruptLines} corrupt trace line(s) skipped.</b>`
    : ''
  const ladders = d.ladders.map((l) => `
    <div class="ladder"><h3>${escapeHtml(l.tag)}</h3>
      ${l.rows.map((r) => `<div class="lrow"><span class="r">${r.rank}</span><span class="name">${escapeHtml(r.id)}</span><span class="elo">${Math.round(r.elo)}</span></div>`).join('\n      ')}
    </div>`).join('\n')
  const scouting = d.scouting.length > 0 ? `
  <section class="scouting"><h2>Scouting report</h2>
    ${d.scouting.map((s) => `<div class="scout"><span class="fighter">${escapeHtml(s.model)}</span><span class="note">${escapeHtml(s.note)}</span></div>`).join('\n    ')}
  </section>` : ''
  return `<title>NV-AGENTS ARENA — ${escapeHtml(d.repo)}</title>
<!-- ReshapeX app-ui tokens — DS bundle snapshot 2026-07-03 -->
<style>
${TOKEN_CSS}
</style>
<div class="hall">
<header>
  <p class="eyebrow">nv-agents · blind model tournaments · NVIDIA NIM free endpoints</p>
  <h1>Arena <span class="accent">/</span> Match Board</h1>
  <div class="venue">
    <span>VENUE <b>${escapeHtml(d.repo)}</b></span>
    <span>GENERATED <b>${escapeHtml(d.generatedAt.slice(0, 10))}</b></span>
    <span>PURSE <b>$0.00</b></span>
  </div>
</header>
<div class="floor">
<div class="col">
  <section><h2>Recent bouts</h2>
  ${d.bouts.map(boutHtml).join('\n  ')}
  </section>
  <section><h2>Season record — orchestrator verdicts</h2>
    <div class="record">
      <span class="w">${d.record.accepted} accepted</span>
      <span class="rw">${d.record.reworked} reworked</span>
      <span class="l">${d.record.rejected} rejected</span>
      <span>${d.counters.aborted} no-contest</span>
    </div>
  </section>
  ${scouting}
</div>
<div class="col">
  <section><h2>Frontier tokens not spent</h2>
    <div class="counter-grid">
      <div class="counter wide"><div class="num accent">${fmt(d.counters.promptTokens + d.counters.completionTokens)}</div>
        <div class="lbl">NIM tokens across ${d.counters.runs} runs (all-time) · ${fmt(d.counters.promptTokens)} in / ${fmt(d.counters.completionTokens)} out</div></div>
      <div class="counter"><div class="num">${usd(d.counters.sonnetEquivUsd)}</div><div class="lbl">Sonnet-equivalent saved</div></div>
      <div class="counter"><div class="num">${usd(d.counters.opusEquivUsd)}</div><div class="lbl">Opus-equivalent saved</div></div>
      <div class="counter"><div class="num">${fmt(d.counters.requests)}</div><div class="lbl">API requests</div></div>
      <div class="counter"><div class="num accent">$0.00</div><div class="lbl">Actually paid</div></div>
    </div>
  </section>
  <section><h2>Elo ladders</h2>
  ${ladders}
  </section>
</div>
</div>
<footer>
  <b>Provenance.</b> Elo ladders come from state (authoritative); bouts and counters come
  from trace files (reporting) — they can legitimately disagree when a trace line is
  corrupt.${corrupt} ${agreementLine}
</footer>
</div>`
}
```

`TOKEN_CSS` is a module-level `const TOKEN_CSS = \`...\`` containing the approved artifact stylesheet verbatim (the `:root` token block with dark values, the `@media (prefers-color-scheme: light)` overrides, `[data-theme="dark"]`/`[data-theme="light"]` blocks, and the component styles: `.hall/.eyebrow/h1/.venue/.floor/.bout/.bout-head/.card/.row/.seed/.fighter/.tale/.delta/.judges/.badge/.inquiry/.counter*/.ladder*/.record/.scouting/.scout/.learning-note/footer` + reduced-motion animation). Copy it from the committed reference template `docs/superpowers/reference/arena-board-template.html` (the maintainer-approved board); add classes for the three new elements:

```css
.badge.split { background: color-mix(in srgb, var(--ui-colors-semantic-warning) 14%, transparent); color: var(--ui-colors-semantic-warning); border: 1px solid var(--ui-colors-semantic-warning); }
.badge.outcome-accepted { border: 1px solid var(--ui-colors-semantic-success); color: var(--ui-colors-semantic-success); }
.badge.outcome-reworked { border: 1px solid var(--ui-colors-semantic-warning); color: var(--ui-colors-semantic-warning); }
.badge.outcome-rejected { border: 1px solid var(--ui-colors-semantic-error); color: var(--ui-colors-semantic-error); }
.learning-note { font-family: var(--ui-typography-mono); font-size: 11.5px; color: var(--ui-colors-text-secondary); margin: 8px 0 0; border-left: 2px solid var(--ui-colors-accent); padding-left: 10px; }
.scout { display: grid; grid-template-columns: auto 1fr; gap: 12px; padding: 6px 0; font-family: var(--ui-typography-mono); font-size: 12px; }
.scout .note { color: var(--ui-colors-text-secondary); }
```

Every named class must exist and reference only `--ui-*` custom properties; the test pins the token values so drift fails loudly.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/board-render.test.ts`, then `pnpm typecheck`. Fix the ladder assertion if markup legitimately differs (number must render rounded).

- [ ] **Step 5: Commit**

```bash
git add src/board/render.ts tests/board-render.test.ts
git commit -m "feat: ReshapeX-tokened match board renderer"
```

---

### Task 7: `nva board` CLI command

**Files:**
- Modify: `src/cli/index.ts`
- Test: extend `tests/cli.test.ts`

**Interfaces:**
- Consumes: `buildBoardData`, `renderBoardHtml` (Tasks 5-6); existing `CliDeps`.
- Produces: `nva board [--out <path>] [--days <n>]` — builds data from `deps.config.runsDir`, catalog, state; writes HTML to `--out` (default `path.join(os.homedir(), '.nv-agents', 'board.html')`, mkdir -p) and prints the absolute path via `print`.

- [ ] **Step 1: Write the failing test**

Append to `tests/cli.test.ts` (reuse `setup()`/`plantState`):

```ts
it('board writes the match board html and prints the path', async () => {
  const { workspace, registryPath, cfg, statePath } = setup()
  plantState(statePath, { 'w/coder': { elo: 1200, matches: 9 } })
  const outPath = path.join(workspace, 'board.html')
  const out: string[] = []
  const cli = buildCli({
    config: cfg, registryPath, statePath, launchDir: workspace,
    client: { chat: async () => { throw new Error('unused') } },
    print: (s) => out.push(s),
  })
  await cli.parseAsync(['node', 'nva', 'board', '--out', outPath])
  expect(out.join('\n')).toContain(outPath)
  const html = fs.readFileSync(outPath, 'utf8')
  expect(html).toContain('NV-AGENTS ARENA')
  expect(html).toContain('w/coder')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/cli.test.ts` — Expected: new test FAILS (unknown command).

- [ ] **Step 3: Implement** — add to `buildCli` after `leaderboard` (imports: `os` from `node:os`, `fs` from `node:fs`, `buildBoardData` from `../board/data`, `renderBoardHtml` from `../board/render`):

```ts
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
```

- [ ] **Step 4: Run all tests**

Run: `pnpm test` and `pnpm typecheck` — all green.

- [ ] **Step 5: Commit**

```bash
git add src/cli/index.ts tests/cli.test.ts
git commit -m "feat: nva board command"
```

---

### Task 8: Policy, live verification, lane finish

**Files:**
- Modify: `CLAUDE.md`

Requires `NVIDIA_API_KEY` (`set -a; source .env; set +a` in the lane).

- [ ] **Step 1: Extend CLAUDE.md**

Replace rule 3 and extend rule 4 in the `**Always**` block:

```markdown
3. Call `report_outcome(run_id, accepted|reworked|rejected)` after deciding —
   this trains routing. For reworked/rejected, ALWAYS pass `learning`: the
   observed behavioral cause + prescription (never style praise). Check the
   model's existing notes in `list_models` first and refine rather than
   restate; use `record_learning` to note behavior of losers/forfeiters/judges
   or to `forget` a note that proved wrong.
```

and append to rule 4 (after the tournament line format):

```markdown
   After report_outcome, refresh the board: `pnpm nva board --out <scratchpad>/arena-board.html`
   and republish the SAME board artifact URL, then emit the report line.
```

- [ ] **Step 2: Live smoke — learning round-trip via CLI-adjacent paths**

```bash
set -a; source .env; set +a
export NVAGENTS_STATE=$(mktemp -d)/state.json
pnpm --silent nva run --task "Create a new file hello-loop.txt containing exactly: hello loop" \
  --workspace . --profile code-gen,fast
pnpm --silent nva board --out /tmp/nv-board-live.html && head -c 400 /tmp/nv-board-live.html
```

Expected: tournament (or gated single) completes; board HTML written; opens with `<title>NV-AGENTS ARENA`. Bouts render with an `unreported` outcome pill (no report_outcome ran — correct).

- [ ] **Step 3: Live briefing check**

Plant a learning directly and confirm injection shows up in behavior (state-level check, no API burn):

```bash
node --import tsx -e "
import { loadState, saveState } from './src/registry/state.ts'
import { loadRegistry, defaultRegistryPath } from './src/registry/registry.ts'
import { addLearning } from './src/arena/elo.ts'
import { buildBriefing } from './src/arena/select.ts'
const catalog = loadRegistry(defaultRegistryPath())
let s = loadState(process.env.NVAGENTS_STATE, catalog)
s = addLearning(s, 'z-ai/glm-5.2', { ts: new Date().toISOString(), note: 'verify every citation against source', tags: [] })
saveState(process.env.NVAGENTS_STATE, s)
console.log(buildBriefing(s, 'z-ai/glm-5.2', ['code-gen'], []))
"
```

Expected: prints `- verify every citation against source`.

- [ ] **Step 4: Full suite, typecheck, finish**

```bash
unset NVAGENTS_STATE && rm -f hello-loop.txt
pnpm test && pnpm typecheck
```

Then use superpowers:finishing-a-development-branch (push `feat/learning-loop`, PR to `main`).

---

## Plan Self-Review Notes

- **Spec coverage:** learnings schema/cap/dedupe/forget T1; tag-aware scrubbed briefing T2; injection worker/arena/delegate (judges excluded) T3; report_outcome learning + idempotency + record_learning + list_models T4; board data (joins, DQ, corrupt-count, counters, ladders, scouting, agreement, days) T5; ReshapeX renderer with escaping + provenance footer T6; CLI T7; CLAUDE.md policy + live verification T8. Deliberate stances (evals coached, judge statelessness) need no tasks.
- **Type consistency:** `Learning` (T1) consumed by T2/T4; `buildBriefing(state, modelId, profile, scrubNames)` signature consistent T2→T3; `BoardData/Bout/BoutRanking` T5→T6→T7; `hasOutcome` T4 only.
- **Known judgment point:** T6's `TOKEN_CSS` is copied from the approved artifact stylesheet; the test pins the token VALUES so a reconstruction can't drift silently.
