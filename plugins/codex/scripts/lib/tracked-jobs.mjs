import fs from "node:fs";
import process from "node:process";

import { resolveJobLogFile, updateJobRecord } from "./state.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";

export function nowIso() {
  return new Date().toISOString();
}

function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      threadId: typeof value.threadId === "string" && value.threadId.trim() ? value.threadId.trim() : null,
      turnId: typeof value.turnId === "string" && value.turnId.trim() ? value.turnId.trim() : null,
      stderrMessage: value.stderrMessage == null ? null : String(value.stderrMessage).trim(),
      logTitle: typeof value.logTitle === "string" && value.logTitle.trim() ? value.logTitle.trim() : null,
      logBody: value.logBody == null ? null : String(value.logBody).trimEnd()
    };
  }

  return {
    message: String(value ?? "").trim(),
    phase: null,
    threadId: null,
    turnId: null,
    stderrMessage: String(value ?? "").trim(),
    logTitle: null,
    logBody: null
  };
}

export function appendLogLine(logFile, message) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) {
    return;
  }
  fs.appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, "utf8");
}

export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  fs.appendFileSync(logFile, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`, "utf8");
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

export function createJobRecord(base, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = env[options.sessionIdEnv ?? SESSION_ID_ENV];
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {})
  };
}

export function createJobProgressUpdater(workspaceRoot, jobId) {
  let lastPhase = null;
  let lastThreadId = null;
  let lastTurnId = null;

  return (event) => {
    const normalized = normalizeProgressEvent(event);
    const activityAt = nowIso();
    const patch = {
      id: jobId,
      lastActivityAt: activityAt
    };

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
    }

    if (normalized.threadId && normalized.threadId !== lastThreadId) {
      lastThreadId = normalized.threadId;
      patch.threadId = normalized.threadId;
    }

    if (normalized.turnId && normalized.turnId !== lastTurnId) {
      lastTurnId = normalized.turnId;
      patch.turnId = normalized.turnId;
    }

    updateJobRecord(workspaceRoot, jobId, (current, { indexedJob }) => {
      if (!indexedJob || !current || !isActiveJobStatus(current.status)) {
        return null;
      }
      return {
        ...current,
        ...patch
      };
    });
  };
}

export function createProgressReporter({ stderr = false, logFile = null, onEvent = null } = {}) {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    const stderrMessage = event.stderrMessage ?? event.message;
    if (stderr && stderrMessage) {
      process.stderr.write(`[codex] ${stderrMessage}\n`);
    }
    appendLogLine(logFile, event.message);
    appendLogBlock(logFile, event.logTitle, event.logBody);
    onEvent?.(event);
  };
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

export async function runTrackedJob(job, runner, options = {}) {
  const startedAt = nowIso();
  const runningRecord = updateJobRecord(job.workspaceRoot, job.id, (current, { indexedJob }) => {
    if (options.requireExisting && !indexedJob) {
      return null;
    }
    if (current && !isActiveJobStatus(current.status)) {
      return null;
    }
    return {
      ...(current ?? {}),
      ...job,
      status: "running",
      startedAt,
      lastActivityAt: startedAt,
      phase: "starting",
      pid: process.pid,
      workerPid: process.pid,
      logFile: options.logFile ?? job.logFile ?? null
    };
  });
  if (!runningRecord) {
    throw new Error(`Job ${job.id} is no longer active.`);
  }

  try {
    const execution = await runner();
    const completionStatus = execution.exitStatus === 0 ? "completed" : "failed";
    const completedAt = nowIso();
    const completedRecord = updateJobRecord(job.workspaceRoot, job.id, (current, { indexedJob }) => {
      if (options.requireExisting && !indexedJob) {
        return null;
      }
      if (!current || !isActiveJobStatus(current.status)) {
        return null;
      }
      return {
        ...current,
        status: completionStatus,
        threadId: execution.threadId ?? null,
        turnId: execution.turnId ?? null,
        summary: execution.summary,
        pid: null,
        phase: completionStatus === "completed" ? "done" : "failed",
        lastActivityAt: completedAt,
        completedAt,
        result: execution.payload,
        rendered: execution.rendered
      };
    });
    if (completedRecord) {
      appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered);
    }
    return execution;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const completedAt = nowIso();
    const failedRecord = updateJobRecord(job.workspaceRoot, job.id, (current, { indexedJob }) => {
      if (options.requireExisting && !indexedJob) {
        return null;
      }
      if (!current || !isActiveJobStatus(current.status)) {
        return null;
      }
      return {
        ...current,
        status: "failed",
        phase: "failed",
        errorMessage,
        pid: null,
        lastActivityAt: completedAt,
        completedAt,
        logFile: options.logFile ?? job.logFile ?? current.logFile ?? null
      };
    });
    if (!failedRecord) {
      throw error;
    }
    throw error;
  }
}
