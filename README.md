# Elodrome

An MCP server + CLI that lets Claude Code delegate coding tasks to NVIDIA NIM models (free endpoints) through a server-side pipeline — agentic read-only workers propose changes, a different model reviews them, and by default delegations run as blind tournaments where 2–3 models compete, a two-judge panel ranks anonymized entries, and per-tag Elo ratings accumulate into a per-repo leaderboard that routing learns from.

## Why

NVIDIA hosts NIM inference endpoints at no cost, so the marginal model call is free.
Once extra calls are free, competition and cross-review stop being luxuries and
become rational defaults: it costs nothing to run two or three workers in parallel
on the same task and have a different model rank them blind. The orchestrator LLM
(Claude Code) stays the strategist and the only write path — it decides what to
delegate, reviews proposed changes, applies the ones it accepts, and reports the
outcome back so routing improves with use. The by-product of all those free calls
is a per-repo, per-capability Elo leaderboard that no public benchmark can match,
measured on *your* codebase.

## How it works

`delegate` takes a task, a workspace, and a `task_profile` of capability tags. If an
explicit `model` is passed it bypasses routing (single mode); otherwise a confidence
gate decides single vs tournament. The full path lives in `src/pipeline/delegate.ts`.

```mermaid
flowchart TD
    A[delegate: task, workspace, task_profile] --> B{Confidence gate<br/>decide — select.ts}
    B -->|explicit model, or dominant champion<br/>matches ≥5 & Elo lead ≥100| C[Single Mode]
    B -->|otherwise| D[Tournament Mode<br/>top-2 Elo + 1 explorer]
    C --> E[Worker Loop<br/>read-only sandbox] --> F[Patch Validation<br/>realpath + denylist]
    F --> G[Critique<br/>cross-model review] --> H{Pass & valid?}
    H -->|No, one revision| E
    H -->|Yes| I[Done → report_outcome]
    D --> J[Parallel Worker Loops<br/>same read-only sandbox] --> K[Blind 2-Judge Panel<br/>anonymized A/B/C, ranks + verdicts]
    K --> L{Any judge verdict = fail for winner?}
    L -->|Yes, one revision| M[Winner revises] --> N
    L -->|No| N[Elo Update<br/>applyTournament, K=32, per tag] --> I
```

Single mode returns proposed changes plus a critique (one revision if the critique
fails). Tournament mode runs contestants concurrently, scores anonymized entries with
a two-judge panel, gives the winner one revision round iff any judge flagged it `fail`,
then applies pairwise Elo deltas per profile tag. Forfeits are classified: infra errors
(429/5xx/404) are no-contests that record an availability strike with no Elo effect,
while task failures count as last-place losses.

## Quickstart

```bash
pnpm install
export NVIDIA_API_KEY=...   # from build.nvidia.com (no charge); elodrome fails fast if unset
```

Register the server with Claude Code by copying `.mcp.json.example` to `.mcp.json`
and filling in the repo path (`.mcp.json` is git-ignored so your local path never
gets committed):

```bash
cp .mcp.json.example .mcp.json
# then edit .mcp.json, replacing /path/to/this/repo with this repo's absolute path
```

```json
{
  "mcpServers": {
    "elodrome": {
      "command": "sh",
      "args": [
        "-c",
        "cd /path/to/this/repo && set -a && { [ -f .env ] && . ./.env; }; set +a; exec pnpm mcp"
      ]
    }
  }
}
```

### MCP tools

- `delegate` — Delegate a coding/research task through the full pipeline (worker loop →
  validation → critique/judging). Takes `task`, `workspace` (absolute path),
  `task_profile` (capability tags), optional `model` to force a specific worker.
  Returns proposed changes for **you** to review and apply — the worker never writes.
- `consult` — Single-shot second opinion from a specific NIM model. No tools, no
  pipeline — prompt and reply. Good for design questions and tie-breaking.
- `list_models` — Registry models with capability tags, tool-calling reliability,
  eval scores, and outcome win rates. Use it to pick a model.
- `leaderboard` — Per-repo Elo ratings and match counts per capability tag, built from
  tournament results and outcome reports. Optional `tag` filter.
- `report_outcome` — **Required** after every `delegate`, once you've reviewed the
  result: record `accepted` | `reworked` | `rejected`. Feeds win rates used for future
  routing (Elo nudge +8 / −4 / −16).

### CLI (`elodrome`)

```bash
pnpm elodrome models                                                                 # list registry models + win rates
pnpm elodrome run --task "..." --workspace $PWD --profile code-gen,fast [--model id] # delegate via full pipeline
pnpm elodrome eval --suite evals/coding-basic.yaml --workspace $PWD --model id       # run an eval suite against a model
pnpm elodrome leaderboard [--tag code-gen] [--md]                                    # per-tag Elo rankings
pnpm elodrome board --out board.html [--days 7]                                      # write an HTML Arena match board
```

Outputs >20KB from a tool are written to `<runsDir>/payloads/<runId>.json` and returned
by path (`~/.elodrome/runs` by default). State lives at `~/.elodrome/state.json`
(lockfile-guarded); override either with `ELODROME_RUNS_DIR` / `ELODROME_STATE`.

## The Arena

Tournament is the default delegation path; the confidence gate (`decide` in
`src/arena/select.ts`) routes single-mode only when a dominant champion exists for the
primary tag (≥5 matches and ≥100 Elo lead over the runner-up), earning back
single-model speed with no contest overhead. Otherwise the arena selects the top-2
primary-tag Elo models plus one least-tested explorer (3 contestants, scaled to 2 if the
catalog is thin) and runs their worker loops in parallel against one shared read-only
sandbox. Entries are anonymized via a stable shuffle to labels A/B/C with model names
scrubbed from entry text, then a two-judge panel of `review`-tag models (excluded from
the contest) ranks and verdicts them blind; a rank-sum aggregate decides the winner, with
the higher-Elo judge breaking ties. Forfeits are classified by cause: infra failures
(NIM 429/5xx/404) are no-contests excluded from judging and Elo but logged as an
availability strike, while task failures (malformed submits, blown budget/timeout) count
as last-place losses in every pairwise Elo result. Each tournament updates Elo per
profile tag with K=32, so the leaderboard gets measurably better the more you delegate.
Inspect it with `pnpm elodrome leaderboard --md`, or render the match-level view with
`pnpm elodrome board --out board.html`:

![Arena match board rendered from this repo's own delegation history, showing recent bouts, a flagged review that was overturned on inspection, per-tag Elo ladders, and cumulative token/cost savings](docs/assets/arena-board.png)

## Verification

Add an `elodrome.verify.json` file to your workspace root to have delegate actually run
checks against a worker's proposed changes before they count, instead of relying purely
on cross-model critique:

```json
{
  "typecheck": "pnpm typecheck",
  "test": "pnpm test"
}
```

Each entry is a label mapped to a shell command. After a worker submits, elodrome
applies its proposed changes to a throwaway `git worktree` (checked out from `HEAD`,
hooks disabled) and runs every configured command there — all of them, regardless of
earlier failures, so the worker sees every problem in one pass. If any command fails,
the worker gets the output back and one chance to resubmit; still failing after that
marks the run `failed_review`, the same terminal state a failed critique produces. This
runs in both single and tournament mode — in tournament mode, a contestant that never
fixes its checks is excluded from winning without aborting the match for the others.

Requirements and behavior:

- **Requires a git repository.** No `elodrome.verify.json`, no git repo, no `git`
  binary, or an empty repo (no commits yet) all skip verification entirely —
  `delegate` behaves exactly as it does without this file, so adding it is fully opt-in
  and backward compatible.
- **A malformed file fails fast.** Invalid JSON or the wrong shape throws immediately
  rather than silently skipping, so a typo in the config doesn't masquerade as "not
  configured."
- **Per-command timeout** defaults to 180s; override with `ELODROME_VERIFY_TIMEOUT_MS`.
- **The config itself can't be tampered with.** It's always read from the repo's
  current `HEAD`, never from the worker's own proposed diff — a worker can't rewrite
  `elodrome.verify.json` to change what runs during its own verification.
- Models that need a verify-revision get a note recorded in their learning history
  (surfaced in future briefings), independent of whether that run ultimately passed.

Documented residual limitations (see
[the design spec](docs/superpowers/specs/2026-07-03-worker-self-verification-design.md)
for the full list): verification runs against `HEAD` plus the proposed diff, not any
uncommitted local changes; git submodules aren't initialized in the throwaway worktree;
and command output isn't scanned for secrets before being echoed back to the worker or
written to trace files.

## Safety model

- **Workers are read-only and sandboxed.** Every file path is resolved through
  `realpath` and checked with `isWithin(workspace, ...)` so symlinks can't escape the
  workspace; a case-insensitive secrets denylist (`.env`, `.pem`, `id_*`, `.ssh/`,
  `.aws/`, `.netrc`, `.npmrc`, `.key`, `credentials`, `secrets`) plus `.git` and
  `.gitignore`-filtered paths are rejected.
- **The orchestrator is the only write path.** Workers propose changes (diffs / full
  files); the orchestrator LLM reviews them and applies the ones it accepts with its own
  Edit/Write tools, skipping or redoing invalid ones. Workers never write.
- **Never delegate** architecture/strategy decisions, security-sensitive changes, or
  anything touching secrets or auth — those stay with the frontier model.
- **Outcome reporting trains routing.** Calling `report_outcome` after each delegation
  nudges Elo (+8 accepted / −4 reworked / −16 rejected) on the run's tags, so
  the registry learns which models earn their routing.

## Further reading

- [Architecture](docs/ARCHITECTURE.md) — pipeline, sandbox, state store, MCP/CLI surfaces.
- [Security & Code-Quality Audit](docs/AUDIT-2026-07-03.md) — untrusted-input boundaries and findings.
- [docs/superpowers/](docs/superpowers/) — historical planning docs (plans/specs) from before this
  project was renamed from `nv-agents`/`nva` to `elodrome`; still useful for design context, but
  code samples and commands inside predate the rename.

## License

MIT — see [LICENSE](LICENSE).
