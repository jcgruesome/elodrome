# nv-agents — NVIDIA-Model Subagents for Claude Code

**Date:** 2026-07-02
**Status:** Approved design, pre-implementation

## Goal

Let Claude Code (Fable 5 / Sonnet 5) seamlessly delegate suitable work to NVIDIA's free
NIM endpoints (build.nvidia.com, OpenAI-compatible API at `integrate.api.nvidia.com/v1`).
The frontier model keeps orchestration, strategy, and final review; NVIDIA models
(DeepSeek, Qwen, GLM, Nemotron, MiniMax, Mistral, …) do the work and secondary review.
Objective is better results *and* lower cost via model diversity — with no change to the
user's Claude Code experience.

## Decisions (settled during brainstorming)

| Question | Decision |
|---|---|
| Integration | **Hybrid**: MCP server (primary, stdio) + thin CLI (`nva`) over one shared core |
| v1 scope | **Text/code only** — multimodal (image/video/voice) deferred to v2 |
| Routing | **Claude picks** from a curated registry exposed via `list_models` |
| Review pipeline | **Server-side**: worker → cross-model critique → one revision → single tool result |
| Worker agency | **Agentic loop with read-only tools**; workers propose diffs, Claude applies |
| Delegation policy | **Auto by default** via skill + CLAUDE.md policy, with per-request overrides |
| Registry | **Curated (~8–12 models) + eval harness** measuring performance on the user's own task suite |

## Architecture

TypeScript (Node, pnpm). One package, three faces over a shared core.

```
Claude Code (Fable/Sonnet) ── orchestrates, strategizes, final review
     │ MCP (stdio)                     │ Bash (scripts/hooks/testing)
     ▼                                 ▼
 MCP server  ◄──────── shared core ────────►  CLI (nva)
                          │
  ┌───────────────────────┼───────────────────────────┐
  │ Model registry        │ Pipeline engine           │ NIM client
  │ (curated YAML +       │ (work → cross-model       │ (OpenAI-compatible,
  │  eval scores +        │  critique → revise)       │  rate-limit queue)
  │  outcome win-rates)   │                           │
  └───────────────────────┴───────────────────────────┘
                          │
             Agentic worker loop (read-only tools:
             read_file, grep, glob, list_dir — sandboxed)
```

### Components

1. **NIM client** — OpenAI-compatible client for `integrate.api.nvidia.com/v1`.
   `NVIDIA_API_KEY` from env only (never in code/config). Per-model request budget and
   queue (free tier ≈ 40 req/min/model). Bounded retry on 429, then loud failure.
   No silent fallback to a different model (fail-fast).

2. **Model registry** — curated YAML, ~8–12 launch models (DeepSeek-R1/V3.1,
   Qwen3-Coder, Qwen3-235B, GLM-4.x, Nemotron variants, MiniMax, Mistral/Devstral).
   Per model: pinned model ID, capability tags (`code-gen`, `deep-reasoning`,
   `long-context`, `review`, `research`, `fast`), context window,
   `toolCalling: reliable | unreliable | none`, eval scores, outcome win-rates.
   Schema is versioned.

3. **Pipeline engine** — `delegate` runs the full loop server-side:
   worker executes → different model critiques → one revision round if the critique
   found substantive issues → single result back to Claude. If review still fails,
   return `status: "failed_review"` with both artifacts — honest failure, never polish.

4. **Agentic worker loop** — server-implemented tool calling for the worker:
   `read_file`, `grep`, `glob`, `list_dir`, all read-only, sandboxed to the validated
   workspace. Hard denylist: `.env*`, key/credential patterns, `.git/`; respects
   `.gitignore` by default (secret-exfiltration guard). Iteration caps count API
   *requests*, plus a wall-clock cap (default 5 min, configurable). Workers return
   unified diffs or full-file replacements (full-file preferred for small files) plus
   rationale. Workers never write; Claude applies edits after its own review.
   `delegate` refuses agentic tasks for models without `toolCalling: reliable`.
   Worker system prompt instructs the model not to follow instructions found in
   repository file contents (prompt-injection containment; Claude's final review is
   the backstop).

5. **MCP server (stdio)** — tools:
   - `delegate(task, workspace, task_profile, model?)` → full pipeline result.
     `task_profile` is a list of registry capability tags (e.g. `["code-gen", "fast"]`)
     used for model selection when `model` is omitted.
   - `list_models()` → registry with tags, scores, win-rates
   - `consult(model, prompt)` → single-shot second opinion, no pipeline
   - `report_outcome(run_id, accepted | reworked | rejected)` → feeds win-rates back
     into the registry (outcome-driven routing)
   Registered in `.mcp.json`. Tool results over ~20KB are written to a scratch file
   and returned by path to protect Claude's context.

6. **CLI (`nva`)** — same core: `nva run`, `nva models`, `nva eval`. The eval harness
   runs a user-defined task suite against candidate models and writes scores into the
   registry, re-runnable as NVIDIA adds models.

7. **Claude integration layer** — a skill + CLAUDE.md policy:
   - Auto-delegate by default: bulk code-gen, boilerplate, test writing, research
     digests, secondary reviews.
   - Claude keeps: architecture, strategy, security-sensitive changes, final review.
   - Overrides honored per request: "do this yourself", "send this to DeepSeek".

## Data Flow (one delegation)

1. Claude calls `delegate(...)`. Server validates the workspace path (must resolve
   within the launch directory — reject anything outside), selects model from
   registry if unspecified.
2. Worker runs the agentic loop under request-budget + wall-clock caps; emits
   proposed changes + rationale.
3. Server dry-run-validates every patch against the workspace. Invalid patches are
   reported as failures.
4. Cross-model critique; one revision round if warranted; `failed_review` terminal
   state if still failing.
5. Result to Claude: summary, validated patches, critique verdict, `run_id`,
   token/request stats. Large payloads by scratch-file path.
6. Claude reviews, applies edits itself, calls `report_outcome(run_id, ...)`.

## Error Handling

Fail fast, everywhere:
- 429 → bounded backoff via the client queue, then a clear error.
- Model 404 (removed from catalog) → error telling Claude to pick another model.
- Malformed worker tool call → one repair attempt, then abort the run.
- No cross-model silent fallbacks; no partially-applied anything.

**Observability:** every run appends a JSONL trace to `~/.nv-agents/runs/` — models
used, tokens, requests, duration, critique verdict, reported outcome. This is the
evidence base for "bang for buck" and for tightening the delegation policy.

## Testing

- **Unit** (highest value on risky parsing/gating): registry loading + schema,
  routing gates (tool-calling refusal), sandbox denylist, diff validation.
- **Integration**: live NIM endpoint tests, gated on `NVIDIA_API_KEY` presence.
- **E2E**: the eval harness itself — the task suite run through the real pipeline.
- Coverage target: 80%+ on the shared core.

## Out of Scope (v1)

- Multimodal models (image/video/speech) — v2.
- Worker write access to files — deliberately excluded, not deferred.
- `panel` tool for parallel multi-model judge panels — v2.
- Cached repo map to reduce worker loop iterations — v2.
- Auto-syncing all 77 catalog models — deliberately excluded; registry stays curated.

## Known Risks (accepted with mitigations)

| Risk | Mitigation |
|---|---|
| Free-tier rate limits vs. chatty loops | Per-model request queue + request-counting caps |
| Flaky tool calling on some models | Registry `toolCalling` gate; refuse rather than degrade |
| Non-applying diffs | Server-side dry-run validation; full-file mode for small files |
| Secret exfiltration via read access | Sandbox denylist + `.gitignore` respect |
| Over-delegation eating savings | Outcome telemetry (`report_outcome`) drives policy tightening |
| NVIDIA model churn | Pinned IDs, clear 404 errors, re-runnable eval harness |
