---
description: Subscribe to one detached Codex job through Claude Monitor, then fetch its durable terminal output with codex:result
argument-hint: '<job-id>'
allowed-tools: Monitor, Skill
---

Launch exactly one `Monitor` task from the current orchestrating Claude agent:

```typescript
Monitor({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" await-result "$ARGUMENTS --timeout-ms 2760000 --monitor"`,
  description: "Wait for Codex job result",
  timeout_ms: 2820000,
  persistent: false
})
```

Rules:

- The argument must identify the detached Codex job returned by a `--background` launch.
- Monitor owns only the watcher command. The Codex worker remains detached and companion-owned.
- Launch Monitor from the main orchestrating agent, never from `codex:code-executor`, `codex:codex-rescue`, or another thin forwarding agent.
- Do not monitor the launcher Agent or Skill task ID. Only the companion job ID is authoritative.
- Monitor output is human-readable and lifecycle-only. Ordinary Codex messages, commands, file changes, elapsed-time updates, and repeated phases stay silent; use `/codex:status <job-id>` when detailed progress is needed.
- Treat non-terminal Monitor events as informational and keep waiting without replying to the user. The terminal line names the job status and `/codex:result <job-id>` command.
- When the job reaches `completed`, `failed`, or `cancelled`, immediately use the `Skill` tool to invoke `codex:result` with exactly the companion job ID. Return that Skill output to the caller as the authoritative result.
- Never read the Monitor task output file, tail job logs, or parse findings from the truncated Monitor notification. Monitor only signals terminal state; `codex:result` reads the durable stored result.
- On watcher timeout, report the timeout and job ID without calling `codex:result`, because the job is not terminal.
- Treat Monitor's terminal notification and command exit status as authoritative for watcher state: exit 0 is completed; non-zero is failed, cancelled, or watcher timeout.
- If the Monitor task is interrupted with the Claude session, the detached Codex job keeps running. Recover with `/codex:status <job-id>` or invoke this command again.
- Return the Monitor launch receipt as-is while waiting so the caller can track its task ID.
