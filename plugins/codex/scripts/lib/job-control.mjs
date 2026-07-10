import fs from "node:fs";

import { getSessionRuntimeStatus } from "./codex.mjs";
import { isProcessRunning } from "./process.mjs";
import { getConfig, listJobs, readJobFile, resolveJobFile, updateJobRecord } from "./state.mjs";
import { appendLogLine, SESSION_ID_ENV } from "./tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

export const DEFAULT_MAX_STATUS_JOBS = 8;
export const DEFAULT_MAX_PROGRESS_LINES = 4;
export const DEFAULT_MISSING_WORKER_GRACE_MS = 30_000;

export function sortJobsNewestFirst(jobs) {
  return [...jobs].sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
}

function getCurrentSessionId(options = {}) {
  return options.env?.[SESSION_ID_ENV] ?? process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentSession(jobs, options = {}) {
  const sessionId = getCurrentSessionId(options);
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

function toTimestamp(value) {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "number") {
    return value;
  }
  return Date.parse(value ?? "");
}

function getNowTimestamp(options) {
  const value = typeof options.now === "function" ? options.now() : options.now ?? Date.now();
  const timestamp = toTimestamp(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error("Active-job reconciliation requires a valid current time.");
  }
  return timestamp;
}

function getMissingWorkerGraceMs(options) {
  const value = Number(options.missingWorkerGraceMs ?? DEFAULT_MISSING_WORKER_GRACE_MS);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_MISSING_WORKER_GRACE_MS;
}

function archiveFailedJob(workspaceRoot, latest, workerPid, errorMessage, completedAt) {
  const failedJob = updateJobRecord(workspaceRoot, latest.id, (current) => {
    if (!current || !isActiveJobStatus(current.status)) {
      return null;
    }
    const currentWorkerPid = current.workerPid ?? current.pid;
    if (currentWorkerPid !== workerPid) {
      return null;
    }
    return {
      ...current,
      status: "failed",
      phase: "failed",
      pid: null,
      ...(Number.isInteger(workerPid) && workerPid > 0 ? { workerPid } : {}),
      completedAt,
      errorMessage
    };
  });
  if (!failedJob) {
    return null;
  }
  appendLogLine(failedJob.logFile, `${errorMessage} Archived the job as failed.`);
  return failedJob;
}

export function reconcileActiveJobs(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const processRunning = options.isProcessRunning ?? isProcessRunning;
  const nowTimestamp = getNowTimestamp(options);
  const reconciledAt = new Date(nowTimestamp).toISOString();
  const missingWorkerGraceMs = getMissingWorkerGraceMs(options);
  const reconciled = [];
  const workerAliveById = new Map();
  const inspectedWorkerPidById = new Map();

  for (const job of listJobs(workspaceRoot)) {
    if (!isActiveJobStatus(job.status)) {
      continue;
    }

    const workerPid = job.workerPid ?? job.pid;
    inspectedWorkerPidById.set(job.id, workerPid ?? null);
    const hasWorkerPid = Number.isInteger(workerPid) && workerPid > 0;
    let errorMessage;
    if (hasWorkerPid) {
      const workerAlive = processRunning(workerPid);
      workerAliveById.set(job.id, workerAlive);
      if (workerAlive) {
        continue;
      }
      errorMessage = `Worker process ${workerPid} is no longer running.`;
    } else {
      const startupTimestamp = toTimestamp(job.startedAt ?? job.queuedAt ?? job.createdAt ?? job.updatedAt);
      if (Number.isFinite(startupTimestamp) && nowTimestamp - startupTimestamp <= missingWorkerGraceMs) {
        workerAliveById.set(job.id, null);
        continue;
      }
      workerAliveById.set(job.id, false);
      errorMessage = Number.isFinite(startupTimestamp)
        ? `No worker PID was recorded within the ${missingWorkerGraceMs}ms startup grace period.`
        : "No worker PID or valid startup timestamp was recorded.";
    }

    // Re-read before writing so a worker that completed during the liveness
    // probe is never overwritten with a synthetic failure.
    const latest = listJobs(workspaceRoot).find((candidate) => candidate.id === job.id);
    const latestWorkerPid = latest?.workerPid ?? latest?.pid;
    if (!latest || !isActiveJobStatus(latest.status) || latestWorkerPid !== workerPid) {
      workerAliveById.delete(job.id);
      inspectedWorkerPidById.delete(job.id);
      continue;
    }

    const failedJob = archiveFailedJob(workspaceRoot, latest, workerPid, errorMessage, reconciledAt);
    if (failedJob) {
      reconciled.push(failedJob);
    }
  }

  return { reconciled, workerAliveById, inspectedWorkerPidById };
}

function getJobTypeLabel(job) {
  if (typeof job.kindLabel === "string" && job.kindLabel) {
    return job.kindLabel;
  }
  if (job.kind === "adversarial-review") {
    return "adversarial-review";
  }
  if (job.jobClass === "review") {
    return "review";
  }
  if (job.jobClass === "task") {
    return "rescue";
  }
  if (job.kind === "review") {
    return "review";
  }
  if (job.kind === "task") {
    return "rescue";
  }
  return "job";
}

function stripLogPrefix(line) {
  return line.replace(/^\[[^\]]+\]\s*/, "").trim();
}

function isProgressBlockTitle(line) {
  return (
    ["Final output", "Assistant message", "Reasoning summary", "Review output"].includes(line) ||
    /^Subagent .+ message$/.test(line) ||
    /^Subagent .+ reasoning summary$/.test(line)
  );
}

export function readJobProgressPreview(logFile, maxLines = DEFAULT_MAX_PROGRESS_LINES) {
  if (!logFile || !fs.existsSync(logFile)) {
    return [];
  }

  const lines = fs
    .readFileSync(logFile, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => line.startsWith("["))
    .map(stripLogPrefix)
    .filter((line) => line && !isProgressBlockTitle(line));

  return lines.slice(-maxLines);
}

function formatElapsedDuration(startValue, endValue = null) {
  const start = Date.parse(startValue ?? "");
  if (!Number.isFinite(start)) {
    return null;
  }

  const end = endValue ? Date.parse(endValue) : Date.now();
  if (!Number.isFinite(end) || end < start) {
    return null;
  }

  const totalSeconds = Math.max(0, Math.round((end - start) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function looksLikeVerificationCommand(line) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    line
  );
}

function inferLegacyJobPhase(job, progressPreview = []) {
  switch (job.status) {
    case "queued":
      return "queued";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    case "completed":
      return "done";
    default:
      break;
  }

  for (let index = progressPreview.length - 1; index >= 0; index -= 1) {
    const line = progressPreview[index].toLowerCase();
    if (line.startsWith("starting codex") || line.startsWith("thread ready") || line.startsWith("turn started")) {
      return "starting";
    }
    if (line.startsWith("reviewer started") || line.includes("review mode")) {
      return "reviewing";
    }
    if (line.startsWith("searching:") || line.startsWith("calling ") || line.startsWith("running tool:")) {
      return "investigating";
    }
    if (line.startsWith("starting collaboration tool:")) {
      return "investigating";
    }
    if (line.startsWith("running command:")) {
      return looksLikeVerificationCommand(line)
        ? "verifying"
        : job.jobClass === "review"
          ? "reviewing"
          : "investigating";
    }
    if (line.startsWith("command completed:")) {
      return looksLikeVerificationCommand(line) ? "verifying" : "running";
    }
    if (line.startsWith("applying ") || line.startsWith("file changes ")) {
      return "editing";
    }
    if (line.startsWith("turn completed")) {
      return "finalizing";
    }
    if (line.startsWith("codex error:") || line.startsWith("failed:")) {
      return "failed";
    }
  }

  return job.jobClass === "review" ? "reviewing" : "running";
}

export function enrichJob(job, options = {}) {
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;
  const workerPid = job.workerPid ?? job.pid ?? null;
  const hasMatchingWorkerInspection =
    (options.workerAliveById?.has(job.id) ?? false) && options.inspectedWorkerPidById?.get(job.id) === workerPid;
  const inspectedWorkerAlive = hasMatchingWorkerInspection ? options.workerAliveById.get(job.id) : undefined;
  const hasWorkerAlive =
    hasMatchingWorkerInspection &&
    (isActiveJobStatus(job.status) || (job.status === "failed" && inspectedWorkerAlive === false));
  const enriched = {
    ...job,
    ...(hasWorkerAlive ? { workerAlive: inspectedWorkerAlive } : {}),
    kindLabel: getJobTypeLabel(job),
    progressPreview:
      job.status === "queued" || job.status === "running" || job.status === "failed"
        ? readJobProgressPreview(job.logFile, maxProgressLines)
        : [],
    lastActivityAgo: formatElapsedDuration(job.lastActivityAt),
    elapsed: formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? null),
    duration:
      job.status === "completed" || job.status === "failed" || job.status === "cancelled"
        ? formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? job.updatedAt)
        : null
  };

  return {
    ...enriched,
    phase: enriched.phase ?? inferLegacyJobPhase(enriched, enriched.progressPreview)
  };
}

export function readStoredJob(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

function matchJobReference(jobs, reference, predicate = () => true) {
  const filtered = jobs.filter(predicate);
  if (!reference) {
    return filtered[0] ?? null;
  }

  const exact = filtered.find((job) => job.id === reference);
  if (exact) {
    return exact;
  }

  const prefixMatches = filtered.filter((job) => job.id.startsWith(reference));
  if (prefixMatches.length === 1) {
    return prefixMatches[0];
  }
  if (prefixMatches.length > 1) {
    throw new Error(`Job reference "${reference}" is ambiguous. Use a longer job id.`);
  }

  throw new Error(`No job found for "${reference}". Run /codex:status to list known jobs.`);
}

export function buildStatusSnapshot(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const { workerAliveById, inspectedWorkerPidById } = reconcileActiveJobs(workspaceRoot, options);
  const config = getConfig(workspaceRoot);
  const jobs = sortJobsNewestFirst(filterJobsForCurrentSession(listJobs(workspaceRoot), options));
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_STATUS_JOBS;
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;

  const running = jobs
    .filter((job) => job.status === "queued" || job.status === "running")
    .map((job) => enrichJob(job, { maxProgressLines, workerAliveById, inspectedWorkerPidById }));

  const latestFinishedRaw = jobs.find((job) => job.status !== "queued" && job.status !== "running") ?? null;
  const latestFinished = latestFinishedRaw
    ? enrichJob(latestFinishedRaw, { maxProgressLines, workerAliveById, inspectedWorkerPidById })
    : null;

  const recent = (options.all ? jobs : jobs.slice(0, maxJobs))
    .filter((job) => job.status !== "queued" && job.status !== "running" && job.id !== latestFinished?.id)
    .map((job) => enrichJob(job, { maxProgressLines, workerAliveById, inspectedWorkerPidById }));

  return {
    workspaceRoot,
    config,
    sessionRuntime: getSessionRuntimeStatus(options.env, workspaceRoot),
    running,
    latestFinished,
    recent,
    needsReview: Boolean(config.stopReviewGate)
  };
}

export function buildSingleJobSnapshot(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const { workerAliveById, inspectedWorkerPidById } = reconcileActiveJobs(workspaceRoot, options);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const selected = matchJobReference(jobs, reference);
  if (!selected) {
    throw new Error(`No job found for "${reference}". Run /codex:status to inspect known jobs.`);
  }

  return {
    workspaceRoot,
    job: enrichJob(selected, {
      maxProgressLines: options.maxProgressLines,
      workerAliveById,
      inspectedWorkerPidById
    })
  };
}

export function resolveResultJob(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  reconcileActiveJobs(workspaceRoot, options);
  const jobs = sortJobsNewestFirst(reference ? listJobs(workspaceRoot) : filterJobsForCurrentSession(listJobs(workspaceRoot)));
  const selected = matchJobReference(
    jobs,
    reference,
    (job) => job.status === "completed" || job.status === "failed" || job.status === "cancelled"
  );

  if (selected) {
    return { workspaceRoot, job: selected };
  }

  const active = matchJobReference(jobs, reference, (job) => job.status === "queued" || job.status === "running");
  if (active) {
    throw new Error(`Job ${active.id} is still ${active.status}. Check /codex:status and try again once it finishes.`);
  }

  if (reference) {
    throw new Error(`No finished job found for "${reference}". Run /codex:status to inspect active jobs.`);
  }

  throw new Error("No finished Codex jobs found for this repository yet.");
}

export function resolveCancelableJob(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  reconcileActiveJobs(workspaceRoot, options);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const activeJobs = jobs.filter((job) => job.status === "queued" || job.status === "running");

  if (reference) {
    const selected = matchJobReference(activeJobs, reference);
    if (!selected) {
      throw new Error(`No active job found for "${reference}".`);
    }
    return { workspaceRoot, job: selected };
  }

  const sessionScopedActiveJobs = filterJobsForCurrentSession(activeJobs, options);

  if (sessionScopedActiveJobs.length === 1) {
    return { workspaceRoot, job: sessionScopedActiveJobs[0] };
  }
  if (sessionScopedActiveJobs.length > 1) {
    throw new Error("Multiple Codex jobs are active. Pass a job id to /codex:cancel.");
  }

  if (getCurrentSessionId(options)) {
    throw new Error("No active Codex jobs to cancel for this session.");
  }

  throw new Error("No active Codex jobs to cancel.");
}
