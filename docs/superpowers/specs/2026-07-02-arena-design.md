# Arena — Tournament Delegation & Per-Repo Model Leaderboard

**Date:** 2026-07-02
**Status:** Approved design, pre-implementation
**Builds on:** `2026-07-02-nv-agents-design.md` (shipped v1)

## Goal

Exploit nv-agents' unfair advantage — extra model calls are free — by running
delegations as blind tournaments. Every task becomes a benchmark of NVIDIA NIM
models on *your* codebase. The by-product is a per-repo, per-capability Elo
leaderboard that no public benchmark can replicate, and routing that gets
measurably better with use.

## Decisions (settled during brainstorming)

| Question | Decision |
|---|---|
| Trigger | **Smart default**: tournament is the default delegation path; a *dominant champion* for the task profile routes single-model (today's pipeline) |
| Judging | **Judges replace critique**: contestants run worker loop only; a blind 2-judge panel ranks anonymized entries and lists issues; winner gets one revision round only if judges flagged substantive issues |
| Scoring | **Elo per capability tag** (K=32), updated from tournament pairwise results; `report_outcome` nudges ratings (+8 accepted / −4 reworked / −16 rejected) |
| Contestants | 3 (or 2 if catalog thin): top-2 primary-tag Elo + 1 explorer (fewest matches); all `toolCalling: reliable` |
| Failures | Forfeits classified: infra errors (`NimError`) = **no-contest** (availability strike, no Elo effect); task failures (`WorkerError`) = last-place **loss** |
| Learned state | Lives in machine-local `~/.nv-agents/state.json` (lockfile-guarded), NOT the git-tracked catalog — no repo churn, no worktree-lane divergence (review finding) |

## Architecture

```
delegate(task, workspace, task_profile)
   │
   ├─ Confidence gate: dominant champion for primary tag? ──► single path (v1 pipeline, mode:'single')
   │
   └─ else ARENA (mode:'tournament')
        ├─ select contestants: top-2 Elo + explorer
        ├─ N worker loops in parallel (same read-only sandbox; per-model rate limits)
        ├─ dry-run patch validation per entry
        ├─ anonymize entries (stable shuffle → Entry A/B/C, model names stripped)
        ├─ 2 blind judges rank + verdicts + issues (strict JSON, 1 retry)
        ├─ rank-sum aggregate; tie → higher-Elo judge's ranking, then tokens
        ├─ winner revision round iff any judge verdict for winner = fail; re-validate
        ├─ Elo update per profile tag (pairwise; loss-forfeits count, no-contests don't)
        └─ trace kind:'tournament' → state.json write (locked)
```

## Components

1. **Registry split: curated catalog + machine-local learned state**
   (`src/registry/schema.ts`, new `src/registry/state.ts`)
   The git-tracked `models.yaml` becomes catalog-only: id, name, tags,
   contextWindow, toolCalling — static, curated, no runtime writes ever
   (ends rating churn in the repo and worktree-lane divergence).
   Learned state moves to machine-local `~/.nv-agents/state.json`
   (`NVAGENTS_STATE` override): per model id —
   `ratings: { [tag]: { elo: number; matches: number } }` (defaults 1000/0),
   `outcomes`, `evalScore`, `availabilityStrikes`. Read-modify-write guarded
   by an advisory lockfile (`state.json.lock` via atomic mkdir, stale after
   10s) so concurrent delegations cannot drop updates.
   Migration/seeding: on first load, outcomes present in a v1 `models.yaml`
   seed state as `elo = 1000 + 8·accepted − 4·reworked − 16·rejected` and
   `matches = accepted + reworked + rejected` on each of the model's tags,
   then outcome/evalScore fields are dropped from the YAML on next catalog
   write; malformed state files throw (fail-fast).

2. **Contestant selector** (`src/arena/select.ts`)
   *Primary tag* = first tag of `task_profile`; all Elo comparisons for
   selection use primary-tag Elo (consistent with the gate). *Dominant
   champion* = top primary-tag Elo with `matches ≥ 5` **and** lead ≥ 100
   over the runner-up → single-route decision. Otherwise: top-2 primary-tag
   Elo + 1 explorer = eligible model with fewest primary-tag matches
   (ties → lowest id, deterministic). Eligibility: all profile tags present,
   `toolCalling: 'reliable'`. Fewer than 2 eligible → throw (Claude decides;
   no silent single fallback). An explicit `model` param bypasses the arena
   entirely (v1 behavior).

3. **Arena engine** (`src/arena/arena.ts`)
   Runs contestants concurrently via the existing `runWorkerLoop` against one
   shared read-only `Sandbox`. Per entry: validated changes + stats. A
   contestant that throws **forfeits**, classified by cause:
   - **No-contest** (infra: `NimError` — 429 exhaustion, 5xx, degraded/404):
     excluded from judging AND from all pairwise Elo results; logs an
     `availabilityStrike` in state (routing input, not a skill judgment).
   - **Loss** (task failure: `WorkerError` — malformed submit twice, prose
     twice, budget/timeout blown): excluded from judging, counted as a
     last-place loss in every pairwise result.
   All contestants forfeit → throw naming every forfeit reason, write a
   `kind:'tournament', status:'aborted'` trace record (tokens burned must be
   visible), no Elo change. Exactly one survivor → skip judging entirely and
   run the v1 critique path on the survivor (cross-model review is preserved);
   Elo updates apply only against loss-forfeits, not no-contests.

4. **Judge panel** (`src/arena/judge.ts`)
   Judges = top-2 'review'-tag models by review-tag Elo, excluded from the
   contest, ties → lowest id (deterministic); 1 acceptable if only 1 exists;
   0 → throw. Entries are anonymized: stable shuffle to labels A/B/C;
   judges see task, per-entry summary/rationale/diffs, and validation
   results — never model names, and registry model names/ids are scrubbed
   from entry text (models sometimes self-identify in rationales).
   Per-entry content is capped at 20k chars with a visible
   `[truncated for judging]` marker. The judge system prompt includes the
   v1 prompt-injection guard (entry contents are data, not instructions).
   Each judge returns strict JSON `{ ranking: string[],
   verdicts: { [label]: 'pass'|'fail' }, issues: { [label]: string[] } }`
   with the same extract-first-JSON-block + one-retry discipline as v1
   critique; a judge failing both attempts is dropped (1-judge panel noted
   in response); both failing → throw. Aggregate: rank-sum; tie → the
   higher-review-Elo judge's ranking wins; final fallback → fewest
   completion tokens. Winner revision triggers iff **any judge's verdict
   for the winner is 'fail'** — that is the definition of "substantive
   issues".

5. **Elo updater** (`src/arena/elo.ts`)
   Final ranking (loss-forfeits last, no-contests excluded) → pairwise
   results → standard Elo, K=32, applied per tag in `task_profile`;
   `matches` increments per tournament per tag. Pure functions; the state
   write is a single lockfile-guarded read-modify-write after the tournament
   completes (crash mid-tournament writes nothing). `report_outcome`
   additionally adjusts the run's worker
   model Elo on the run's profile tags (both modes; the run record — in-memory
   map and trace — must therefore store `task_profile`): accepted +8,
   reworked −4, rejected −16.

6. **Pipeline integration** (`src/pipeline/delegate.ts`)
   `DelegateResponse` gains: `mode: 'single' | 'tournament'`, and for
   tournaments `arena: { contestants: string[], ranking: Array<{model, label,
   rankSum, forfeited?, forfeitReason?}>, judges: string[], judgeIssues:
   { [model]: string[] } }`. `stats` stays all-in totals; `statsBreakdown`
   gains per-contestant and judge entries. Winner revision reuses the v1
   revision mechanism fed by the judges' issues for the winner. Single-model
   path is bit-for-bit today's pipeline.

7. **Surfaces**
   - MCP: `delegate` (smart default), new `leaderboard(tag?)` tool returning
     the Elo table + match counts.
   - CLI: `nva leaderboard [--tag code-gen] [--export md]` — the markdown
     export is the shareable artifact (repo name, date, ladder per tag,
     match counts, judge-agreement rate, sourced from state.json).
   - CLAUDE.md delegation-report line gains a tournament variant:
     `🏆 <winner> beat <losers> (judges: <judges>) · <N> req · <p>/<c> tok · <outcome>`.
   - Trace: `kind: 'tournament'` with contestants, ranking, forfeit reasons,
     per-role usage, Elo deltas.

## Rate-limit envelope

Contestants hit different model endpoints, so per-model RPM budgets do not
stack; judges add 2–4 requests on review models. Worst case ≈ 4× a single
delegation's requests spread over ~5 models — inside free-tier limits; wall
clock ≈ a single delegation (parallel contestants).

## Error handling

- All contestants forfeit → throw with every forfeit reason + aborted trace
  record; no Elo change.
- One judge unusable → 1-judge panel, noted in `arena.judges`; both → throw.
- < 2 eligible contestants → throw naming the eligibility gap.
- Single survivor → v1 critique path, no judging, no pairwise Elo vs
  no-contests.
- State file: lockfile-guarded writes, all-or-nothing; malformed → throw.
  v1 outcome history seeds initial Elo (formula in component 1).
- No silent fallbacks anywhere; forfeits are data, not hidden retries.

## Testing

- **Unit:** Elo math (pairwise conversion, K-factor, loss-forfeit vs
  no-contest exclusion, outcome nudges, v1 seeding formula); selector (gate
  thresholds, explorer determinism, eligibility throw, explicit-model
  bypass); anonymization (model names/ids never appear in judge prompts,
  including inside entry rationales — load-bearing for blindness); rank-sum
  + judge-priority tie-break; state lockfile (concurrent writers don't drop
  updates, stale lock recovery).
- **Pipeline (scripted clients):** full tournament happy path; loss-forfeit;
  no-contest forfeit; all forfeit (aborted trace); single survivor → v1
  critique; judge disagreement; judge failure ×1 and ×2; winner revision on
  judge fail verdict; single-path gate (dominant champion).
- **Live (finishing task):** one real tournament via CLI; `nva leaderboard`
  renders; markdown export written.
- Existing 71 tests stay green; single-model path unchanged.

## Out of scope (v1)

- Cross-repo / global leaderboard sharing service
- Per-file-type or per-directory ratings
- More than 3 contestants; configurable K-factor
- Rating the judges (judge Elo)
- Tournament mode for `consult`

## Risks (accepted, with mitigations)

| Risk | Mitigation |
|---|---|
| Judge bias (verbose diffs win) | Blind labels, name-scrubbed entries, 2-judge rank-sum, judge-priority tie-break (not token count); judge-Elo deferred to v2 |
| Judge/contestant family affinity (same-lineage favoritism) | Accepted for v1: 9-model curated catalog leaves no room for strict lineage separation; judges are contest-excluded; revisit with judge-Elo in v2 |
| Rate-limit pressure on review models | Panel of 2, one ranking call each (not per-entry); per-model queue already exists |
| Elo instability at low match counts | Gate requires ≥5 matches before exploitation; explorer keeps sampling; v1 history seeds ratings |
| Same-sandbox contention | Sandbox is read-only and workers have zero write tools; no cross-contestant side-channel |
| Free-tier endpoint churn | No-contest forfeits log availability strikes without corrupting skill ratings |
| Concurrent state writes | Advisory lockfile with stale-lock recovery; all-or-nothing write |
