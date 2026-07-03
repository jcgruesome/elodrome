# Elodrome

MCP server + CLI that delegates tasks to NVIDIA NIM models. Run tests with
`pnpm test`, typecheck with `pnpm typecheck`. `NVIDIA_API_KEY` must be exported.

## Delegation policy (elodrome MCP server)

When the `elodrome` MCP tools are available, follow this policy:

**Delegate by default** (via `delegate`): bulk code generation, boilerplate,
test writing, refactors with clear specs, research digests, and secondary code
review. Pick the model yourself from `list_models` (tags + win rates), or pass
`task_profile` and let the registry rank.

**Never delegate**: architecture and strategy decisions, security-sensitive
changes, anything touching secrets or auth, final review. Those stay with the
frontier model (you).

**Always**:
1. Review returned changes yourself before applying them — workers are
   read-only and you are the write path.
2. Apply valid changes with your own Edit/Write tools; skip or redo invalid ones.
3. Call `report_outcome(run_id, accepted|reworked|rejected)` after deciding —
   this trains routing.
4. Report each completed delegation to the user as one line built from the
   delegate response:
   `⇄ <workerModel> (auto|explicit) → review <reviewerModel>: <verdict>[, revised] · <N> req · <prompt>/<completion> tok · <outcome>`
   e.g. `⇄ z-ai/glm-5.2 (auto) → review deepseek-v4-pro: pass · 2 req · 4.1k/2.5k tok · reworked`.
   "auto" = registry ranked via task_profile; "explicit" = you passed `model`.
   For tournaments (`mode: "tournament"`), use:
   `🏆 <workerModel> beat <other ranked contestants> (judges: <judges>[, split decision if agreement=false]) · <N> req · <prompt>/<completion> tok · <outcome>`

**Overrides**: "do this yourself" means no delegation; "send this to <model>"
means delegate with that explicit `model`. Use `consult` for quick second
opinions without the pipeline.
