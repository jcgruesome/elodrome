# Worker Self-Verification — Run Checks Before a Submission Counts

**Date:** 2026-07-03
**Status:** Approved design, pre-implementation
**Relates to:** first of three planned "elevate elodrome" specs (this one, cost/latency-aware
Elo, and a shared team-wide leaderboard — each gets its own spec/plan/implementation cycle).

## Goal

Today the sandbox is strictly read-only (`read_file`/`list_dir`/`glob`/`grep`) and a worker's
proposed changes are only checked for "does this diff apply cleanly" (`patch/validate.ts`) before
going to a reviewing model. Nothing ever actually runs the proposed code. This means a change that
breaks the build or fails existing tests can still win a tournament or pass review purely on how
plausible it reads.

This spec adds an automatic verification gate: after a worker submits, its changes are applied to
a throwaway git worktree and a repo-configured set of commands (typecheck, test, etc.) run against
them. Failures are fed back to the worker for one revision attempt before the run is marked
`failed_review`. This is a pipeline-level gate, not a new worker tool — the worker never chooses
whether to verify; it always happens when a repo has verification configured.

## Decisions (settled during brainstorming)

| Question | Decision |
|---|---|
| Trigger mechanism | **Automatic gate** after `submit_result`, not a worker-invoked tool. Guarantees every submission is checked. |
| Isolation mechanism | **Git worktree** (`git worktree add --detach`), not a shadow copy or apply-in-place-then-revert. Fast (hardlinks), matches this project's own worktree/"lane" convention, never touches the real working tree. |
| Non-git workspace / `git` unavailable | **Skip silently**, recorded as `verification: 'skipped'` in the response/trace. `delegate()` behaves exactly as it does today — verification is a quality enhancement, never a correctness dependency. |
| Command source | **User-configured per repo** via `elodrome.verify.json` at the workspace root. The worker/model never chooses what runs — same trust level as a human running `pnpm test` themselves. No repo config → verification skipped. |
| Command failure handling | **Run all configured commands, report all failures together** (not stop-on-first-failure) — gives the worker everything to fix in one revision pass. |
| Tournament mode scope | **Both single and tournament mode**, from the start. Each contestant is verified independently before judging. |
| Retry policy | **One revision attempt.** Worker gets the aggregated failure output and one chance to resubmit; still failing → `failed_review`, same terminal state a failed critique produces today. |
| Elo/learning integration | **Record as trace/briefing data only** (pass-on-first-try vs. needed-a-revision), reusing the existing learning-note/briefing mechanism. No new scoring formula — that's deferred to the separate cost/latency-aware Elo spec. |

## Components

### 1. Config: `elodrome.verify.json` (workspace root)

```json
{
  "typecheck": "pnpm typecheck",
  "test": "pnpm test"
}
```

Flat map of label → shell command. Order of execution follows object key order (informational
only, since all commands always run regardless of earlier failures). Missing file or empty object
means verification is skipped for that repo — identical outcome to the non-git case.

New `Config` fields (`src/config.ts`, following the existing `maxWorkerRequests`/`workerTimeoutMs`
pattern):
- `verifyTimeoutMs` — default `180_000`, env `ELODROME_VERIFY_TIMEOUT_MS`. Per-command timeout;
  process is killed on expiry and that command is reported as a failure ("timed out after Nms").
- Output (stdout+stderr merged) truncated to a fixed budget (reusing the `truncate()` idiom from
  `sandbox/tools.ts`, ~4,000 chars per command) before being fed back to the worker or written to
  trace.

### 2. `src/verify/` — new module

```
src/verify/worktree.ts   — create/apply-changes/cleanup for a throwaway git worktree
src/verify/run.ts        — execute configured commands, aggregate results
src/verify/index.ts      — verifyChanges(sandbox, changes, config): Promise<VerifyResult>
```

```typescript
export interface CheckResult { name: string; exitCode: number | null; output: string }
export interface VerifyResult {
  status: 'skipped' | 'passed' | 'failed'
  checks: CheckResult[]   // empty when skipped
  reason?: string         // populated when skipped, e.g. "not a git repository"
}
```

**Worktree creation** (`worktree.ts`): detect the repo via `git rev-parse --show-toplevel` run
from the sandbox root; `ENOENT` (git missing) or non-zero exit (not a repo) → `skipped`. On
success, `git worktree add --detach <tmpdir> HEAD` into a uniquely-named temp dir under
`os.tmpdir()` (same random-suffix idiom as `newRunId()` in `trace/trace.ts`, so parallel tournament
verifications never collide).

Worktrees are created from `HEAD`, not the live working tree's uncommitted state. This is a known,
documented property: the worker's own reads (via `Sandbox`) see the real working tree including
uncommitted edits, but the *verification* step only sees what's committed plus the proposed diff.
A task that depends on uncommitted local changes will verify without them — acceptable, not a bug,
and out of scope to fix here.

**Applying changes**: `full` changes are written directly (`fs.writeFileSync`); `diff` changes are
applied with the same `applyPatch` (`diff` package) already used in `patch/validate.ts` — guaranteed
to apply cleanly since this only runs after `validateChanges` has already confirmed that.

**Running commands** (`run.ts`): each configured command runs via
`execFile('sh', ['-c', command], { cwd: worktreeRoot, timeout: verifyTimeoutMs })`. All commands
run regardless of earlier failures; results collected into `CheckResult[]`.

**Cleanup**: `git worktree remove --force <tmpdir>` in a `finally`, followed by a defensive
`fs.rmSync(tmpdir, { recursive: true, force: true })` in case git can't clean up on its own (e.g.
process killed mid-run). No leftover worktrees or temp dirs on any exit path, including timeouts
and thrown errors.

### 3. Pipeline integration

**`singleDelegate` (`src/pipeline/delegate.ts`)**: after `validateChanges` produces all-valid
changes, call `verifyChanges`. On `'failed'`, build a revision message from the aggregated
`checks` (name + truncated output per failing check, all of them) and re-enter the worker loop
once — same shape as the existing failed-critique revision branch, just a different message
source. On `'passed'` or `'skipped'`, proceed to `runCritique` as today.

**Tournament mode (`src/arena/arena.ts`)**: `verifyChanges` runs per-contestant after each one's
`validateChanges`, before judging, in parallel (worktree creation serializes at the git level but
this is still far faster than a shadow copy per contestant). A contestant that still fails
verification after its one revision attempt is excluded from winning — handled the same way a
`no_contest` forfeit is handled today — without aborting the whole tournament if another contestant
is still viable. Judges see a pass/fail verify badge per entry in the anonymized briefing, not raw
command output, to avoid leaking model-identifying command-output style into blind judging.

**`DelegateResponse`**: add `verify: VerifyResult` for single mode, or
`Record<string, VerifyResult>` keyed by contestant for tournament mode (alongside the existing
`arena` field).

**Trace (`src/trace/trace.ts`)**: record `verify: { status, checkNames, revisionUsed: boolean }`
per run — enough to compute "how often does this model need a verify-revision" without bloating
trace files with full command output.

**Briefing (`src/arena/select.ts`, `buildBriefing`)**: extend the existing per-model learning-note
briefing with a derived line when relevant, e.g. *"3 of your last 5 runs needed a verify-revision
(typecheck) before passing."* Reuses the existing learning-note plumbing; no new schema required
beyond what's already read from trace history.

## Error Handling & Safety

- **`git` missing**: `ENOENT` from `execFile('git', ...)` is treated identically to "not a git
  repo" — skip, don't crash `delegate()`.
- **Worktree creation fails for any other reason** (repo in a weird state, disk full, etc.):
  treated as `skipped` with the error message as `reason`. Verification must never block an
  otherwise-valid delegation.
- **Check command times out**: killed via the `execFile` `timeout` option; reported as a failing
  check (`exitCode: null`, output `"timed out after {verifyTimeoutMs}ms"`), flows through the same
  revision/failure path as any other failure.
- **Network access during checks**: not blocked. These are human-configured commands — identical
  trust level to running `pnpm test` locally yourself. This differs from the worker's own tool
  calls, which remain fully sandboxed; it is a documented property, not a gap.
- **Malicious/adversarial diff content**: already covered upstream — `validateChanges` resolves
  every path through `Sandbox.resolve` (containment + denylist) before anything reaches the
  worktree, so nothing outside the repo can be written regardless of what a worker proposes.
- **Leftover worktrees from a crashed prior run**: out of scope for this design (no startup GC
  pass). A candidate follow-up if it proves to be a real problem in practice.

## Testing Strategy

- **`src/verify/worktree.ts`**: unit tests against a real temp git repo (`git init` in
  `beforeAll`, same idiom as `tests/sandbox.test.ts`'s `mkdtempSync` setup) — worktree
  creation/cleanup, non-git-dir detection, both `full` and `diff` change application.
- **`src/verify/run.ts`**: unit tests with fast synthetic commands (`exit 0`, `exit 1`, `sleep` for
  timeout) — no real test suites needed to exercise the logic.
- **`src/verify/index.ts`**: integration test combining both — a temp repo with an
  `elodrome.verify.json` running a trivial command, asserting `passed`/`failed`/`skipped`
  outcomes.
- **`delegate.ts` / `arena.ts` integration**: extend `tests/delegate.test.ts` / `tests/arena.test.ts`
  with a dependency-injected fake `verifyChanges` (same pattern already used for `client.chat`) to
  test the revision-loop wiring without real git operations in every test.
- No changes needed to `tests/tools.test.ts` / `tests/sandbox.test.ts` — the read-only sandbox is
  untouched by this feature.

## Out of Scope (this spec)

- Cost/latency-aware Elo scoring of verify-revision behavior (separate spec).
- Shared team-wide leaderboard / registry (separate spec).
- Startup garbage-collection of orphaned worktrees.
- A worker-invoked `run_check` tool (considered and explicitly rejected in favor of the automatic
  gate — see Decisions table).
