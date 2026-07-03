# Learning Loop & Match Board — Post-Match Feedback for nv-agents

**Date:** 2026-07-03
**Status:** Approved design, pre-implementation
**Builds on:** `2026-07-02-arena-design.md` (shipped, PR #2)

## Goal

Close the loop after every match: (1) record qualitative model-behavior learnings
at verdict time and feed them into future matches as worker "coach's notes";
(2) make the Arena match-night board a standard, regenerable output
(`nva board`) rendered in the ReshapeX design system, refreshed to one
artifact URL after every delegation.

## Decisions (settled during brainstorming)

| Question | Decision |
|---|---|
| Learning authorship | **Claude at verdict time**: `report_outcome` gains optional `learning` string; mandatory by policy for reworked/rejected |
| Feedback mechanism | **Inject into worker prompts**: each contestant's own recent learnings become a briefing appended to its worker system prompt; also exposed in `list_models` |
| Board delivery | **Auto-refresh artifact**: after every `report_outcome`, Claude runs `pnpm nva board` and republishes the same artifact URL + the 🏆/⇄ chat line |
| Board design | **ReshapeX design system**: `renderBoardHtml` emits the tokenized match-night template (Electric Green accent, `#0D1117`/`#1C2128` surfaces, Plus Jakarta Sans / Switzer / JetBrains Mono, dual themes via `prefers-color-scheme` + `[data-theme]`) |

## Components

1. **State schema: learnings** (`src/registry/state.ts`)
   `ModelState` gains `learnings: Array<{ ts: string; note: string; tags: string[]; outcome: 'accepted'|'reworked'|'rejected'; runId: string }>`
   (zod, default `[]`). Capped at the **10 most recent per model** — appending
   the 11th drops the oldest (FIFO). Written only under `withStateLock`.
   `addLearning(state, modelId, entry): NvState` (pure, immutable) lives in
   `src/arena/elo.ts` alongside the other state applicators.

2. **Capture: `report_outcome`** (`src/mcp/server.ts`)
   Input schema gains `learning: z.string().min(8).max(300).optional()`.
   When present it is applied (with the outcome nudge, same lock) to the run's
   worker model with the run's profile tags, and included in the outcome trace
   record. The tool description states the policy: REQUIRED for
   reworked/rejected — name the concrete behavioral cause and the prescription.

3. **Feedback: coach's notes briefing**
   - `runWorkerLoop` (`src/worker/loop.ts`) gains `briefing?: string`; when
     present it is appended to the system prompt under the heading
     `Notes from your previous work in this repo (address these):`.
   - `buildBriefing(state, modelId): string | undefined`
     (`src/arena/select.ts`) returns the model's latest **3** learning notes as
     a bulleted string, or undefined when none. Notes are phrased second-person
     by the author (policy); `buildBriefing` additionally strips any catalog
     model id/name occurrences (reuse `scrubModelNames`) so briefings can never
     leak identity — **judges never see briefings**, and a worker echoing its
     notes leaks nothing past the existing entry scrubber.
   - `delegate` passes each contestant's own briefing in both single and
     tournament modes (arena engine threads it per contestant).
   - `list_models` includes `learnings` (latest 3 notes + ts) per model.

4. **Board generator** (`src/board/data.ts`, `src/board/render.ts`)
   - `buildBoardData(runsDir, catalog, state, opts?: { days?: number }): BoardData`
     joins trace records by `runId`: tournaments + single delegates (bouts,
     newest first, capped at the 8 most recent for the card; all-time counters),
     outcomes (verdict + learning per bout), forfeits/DQ (rejected outcome ⇒
     "stewards' inquiry" styling), aborted runs (no-contest strip), counters
     (all-time requests, prompt/completion tokens, Sonnet-equiv `$3/M + $15/M`
     and Opus-equiv `$15/M + $75/M` savings, runs by mode), Elo ladders from
     state (per tag, top 5), season record from outcome counts, scouting report
     (every model's latest learning). Corrupt trace lines are skipped and
     **counted**; the count renders on the board footer when nonzero.
   - `renderBoardHtml(data): string` emits the self-contained ReshapeX-tokenized
     match-night page (token values baked in from the DS bundle snapshot of
     2026-07-03, provenance comment in the template; no external requests —
     artifact CSP). Sections: masthead, bout cards (champion row in Electric
     Green, DQ cards in semantic error magenta, judges strip + unanimous/split
     badge, learning note when present), season record, counters, Elo ladders,
     scouting report, footer.
   - CLI: `nva board [--out <path>] [--days N]` writes the HTML (default
     `~/.nv-agents/board.html`) and prints the absolute path.

5. **Cadence policy** (`CLAUDE.md`)
   Rule 3 extended: pass `learning` on every reworked/rejected outcome
   (cause + prescription), optionally on notable accepts. Rule 4 extended:
   after `report_outcome`, run `pnpm nva board --out <scratchpad>/arena-board.html`
   and republish the same artifact URL, then emit the 🏆/⇄ line.

## Data flow (one match, end to end)

delegate → (workers get briefings) → judges → winner → Claude reviews →
`report_outcome(run_id, outcome, learning?)` → state: outcome counts + Elo
nudge + learning appended (one lock) → trace: outcome record with learning →
Claude: `pnpm nva board` → artifact republish → next delegate reads the fresh
learnings into briefings.

## Error handling

- `learning` over 300 chars / under 8 chars → zod rejection (fail fast, Claude retries).
- `buildBriefing` never throws: no learnings → undefined (no prompt section).
- Board build: unreadable runsDir → empty bouts + zeroed counters (a fresh
  install has a board, not a crash); **corrupt lines skipped and counted
  visibly**; malformed state still throws (state is load-bearing, traces are
  reporting).
- Board render is pure; CLI write failures propagate (fail fast).

## Testing

- State: learnings schema round-trip; `addLearning` cap/FIFO + immutability.
- Server: `report_outcome` with learning persists note + nudge under one lock,
  trace includes it; length validation rejects.
- Briefing: `buildBriefing` picks latest 3, scrubs names, undefined when empty;
  worker-loop test asserts briefing text lands in the system prompt; delegate
  test asserts contestants receive their own (and only their own) briefings.
- Board: `buildBoardData` against fixture traces (bout join, DQ from rejected,
  aborted strip, corrupt-line count, counters math); `renderBoardHtml` content
  assertions (tokens present, bout rows, DQ styling class, both theme blocks);
  CLI `board` command writes file and prints path.
- Existing 121 tests stay green.

## Out of scope (v1)

- Auto-reflection / model-drafted learnings
- Learnings as machine-readable selection modifiers
- Per-tag learning taxonomies; learning expiry beyond the 10-cap
- Board time-travel / per-day archives; publishing from the server itself

## Risks (accepted, with mitigations)

| Risk | Mitigation |
|---|---|
| Learning prompt bloat | 10-cap in state, 3 injected, 300-char limit |
| Briefing leaks identity to judges | Briefings only in worker prompts; scrubbed of catalog names; entry scrubber remains the backstop |
| Poisoned learnings steering workers wrong | Sole author is Claude at verdict time — the same reviewer whose judgment gates every change |
| Board drift from DS updates | Token values carry a provenance comment + date; refresh is a one-file re-export |
