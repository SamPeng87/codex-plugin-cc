---
description: Review a test strategy document (test-plan.md) from the Obsidian vault
argument-hint: '[--wait|--background] [--path <vault-folder>|--task <task-id>] [--model <model>] [--effort <none|minimal|low|medium|high|xhigh|max>] [focus ...]'
disable-model-invocation: false
allowed-tools: Bash(node:*), Bash(find:*), AskUserQuestion, Agent
---

Invoke the `codex:document-reviewer` subagent via the `Agent` tool (`subagent_type: "codex:document-reviewer"`), forwarding the raw user request as the prompt.
`codex:document-reviewer` is a subagent, not a skill — do not call `Skill(codex:document-reviewer)` (no such skill). The command runs inline so the `Agent` tool stays in scope.
The final user-visible response must be Codex's output verbatim.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return Codex's output verbatim to the user.

Execution mode:
- If the request includes `--background`, run the `codex:document-reviewer` subagent in the background.
- If the request includes `--wait`, run the `codex:document-reviewer` subagent in the foreground.
- If neither flag is present, default to foreground.
- `--background` and `--wait` are execution flags for Claude Code. Do not forward them to the companion script; the subagent handles the Bash call.
- Then use `AskUserQuestion` exactly once with two options, putting the recommended option first and suffixing its label with `(Recommended)`:
  - `Wait for results (Recommended)`
  - `Run in background`

Path resolution:
- `/codex:test-plan-review` requires `--path <vault-folder>` or `--task <task-id>` to locate the test-plan.md document.
- The companion script also reads plan.md from the same folder to verify coverage alignment.
- If the user provides `--path`, pass it through directly.
- If the user provides `--task`, pass it through directly. The companion script resolves the vault folder.
- If neither is provided, check the current conversation context for a vault folder or task ID. If found, use `--path`. Otherwise, ask the user.
- It can also take extra focus text after the flags.
- `--model` and `--effort` are runtime-selection flags. Forward them unchanged and do not include them in the focus text.

Subagent prompt:
When spawning the subagent, tell it:
- The subcommand is `test-plan-review`
- The full arguments string to pass: `$ARGUMENTS` (with `--wait` and `--background` stripped)
- Example: "Run: `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" test-plan-review --path /some/vault/folder focus text`"

Foreground flow:
- Spawn the subagent inline and return its output verbatim to the user.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the review output.

Background flow:
- Spawn the subagent in the background:
```typescript
Agent({
  subagent_type: "codex:document-reviewer",
  prompt: `Run: node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" test-plan-review "$ARGUMENTS"`,
  description: "Codex test plan review",
  run_in_background: true
})
```
- After launching, tell the user: "Codex test plan review started in the background. Check `/codex:status` for progress."
