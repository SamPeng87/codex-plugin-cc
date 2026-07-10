---
description: Subscribe to one detached Codex job and deliver its terminal result through Claude Monitor
argument-hint: '<job-id>'
allowed-tools: Monitor
---

Launch exactly one `Monitor` task from the current orchestrating Claude agent:

```typescript
Monitor({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" await-result "$ARGUMENTS --timeout-ms 2760000 --jsonl"`,
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
- Do not poll `codex:status`, read task output files, tail logs, or call `codex:result` afterward. `await-result` emits deduplicated progress events and the stored terminal result itself.
- Progress events include the current phase, elapsed time, recent activity, the latest Codex message, and cumulative file-change statistics when available. Unchanged polling snapshots stay silent.
- Treat `event: "progress"` as informational and keep waiting. Only `event: "result"` or `event: "timeout"` is terminal.
- The terminal event remains one compact JSON line so Monitor delivers the complete stored result instead of a partial multi-line payload.
- Treat Monitor's terminal notification and command exit status as authoritative: exit 0 is completed; non-zero is failed, cancelled, or watcher timeout.
- If the Monitor task is interrupted with the Claude session, the detached Codex job keeps running. Recover with `/codex:status <job-id>` or invoke this command again.
- Return the Monitor launch receipt as-is so the caller can track its task ID.
