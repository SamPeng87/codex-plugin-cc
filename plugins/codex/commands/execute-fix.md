---
description: Run tests and fix implementation to make them pass
argument-hint: '[--background|--wait] --context-file <path> [--task <id>|--path <folder>] [--model <model>] [--write] [--resume-last|--fresh] [resume prompt...]'
allowed-tools: Agent
---

Spawn the `codex:code-executor` subagent via the `Agent` tool (`subagent_type: "codex:code-executor"`), forwarding the raw arguments as the prompt.

`codex:code-executor` is a subagent, not a skill — do not call `Skill(codex:code-executor)` (no such skill) or `Skill(codex:execute-fix)` (that re-enters this command and hangs the session).

The subagent calls `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" execute-fix $ARGUMENTS` and returns stdout as-is.

The final user-visible response must be the Codex output verbatim.

Raw arguments:
$ARGUMENTS

Execution mode:

- If the request includes `--background`, run the subagent in the background.
- If the request includes `--wait`, run the subagent in the foreground.
- If neither flag is present, default to foreground.
- `--background` and `--wait` are execution flags for Claude Code. Do not forward them to the companion script.
- `--resume-last`, `--resume`, `--fresh`, `--model`, `--write`, `--task`, `--path`, `--context-file` are runtime flags. Forward them to the companion script as-is.

Operating rules:

- The subagent is a thin forwarder only. It should use one `Bash` call to invoke the companion script and return stdout as-is.
- Return the Codex companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary.
- Do not ask the subagent to inspect files, monitor progress, poll status, or do follow-up work.
