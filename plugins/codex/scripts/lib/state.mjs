import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "codex-companion");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;
const JOB_INDEX_DETAIL_FIELDS = ["request", "result", "rendered"];
const STATE_LOCK_DIR_NAME = ".state.lock";
const STATE_LOCK_OWNER_FILE_NAME = "owner.json";
const STATE_LOCK_REAPER_FILE_NAME = ".state.lock.reaper";
const STATE_LOCK_RETRY_MS = 10;
const STATE_LOCK_ACQUIRE_TIMEOUT_MS = 15_000;
const STATE_LOCK_STALE_MS = 10_000;
const sleepBuffer = new SharedArrayBuffer(4);

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return stateFileInDir(resolveStateDir(cwd));
}

export function resolveJobsDir(cwd) {
  return jobsDirInStateDir(resolveStateDir(cwd));
}

export function ensureStateDir(cwd) {
  ensureStateDirPath(resolveStateDir(cwd));
}

function stateFileInDir(stateDir) {
  return path.join(stateDir, STATE_FILE_NAME);
}

function jobsDirInStateDir(stateDir) {
  return path.join(stateDir, JOBS_DIR_NAME);
}

function jobFileInStateDir(stateDir, jobId) {
  return path.join(jobsDirInStateDir(stateDir), `${jobId}.json`);
}

function ensureStateDirPath(stateDir) {
  fs.mkdirSync(jobsDirInStateDir(stateDir), { recursive: true });
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(sleepBuffer), 0, 0, milliseconds);
}

function atomicWriteFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryFile = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  );

  try {
    fs.writeFileSync(temporaryFile, contents, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporaryFile, filePath);
  } finally {
    removeFileIfExists(temporaryFile);
  }
}

function readLockOwner(lockDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(lockDir, STATE_LOCK_OWNER_FILE_NAME), "utf8"));
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function lockAgeMilliseconds(lockDir, owner) {
  const acquiredAt = Date.parse(owner?.acquiredAt ?? "");
  if (Number.isFinite(acquiredAt)) {
    return Date.now() - acquiredAt;
  }

  try {
    return Date.now() - fs.statSync(lockDir).mtimeMs;
  } catch {
    return 0;
  }
}

function isValidLockOwner(owner) {
  return (
    owner != null &&
    Number.isInteger(owner.pid) &&
    owner.pid > 0 &&
    typeof owner.token === "string" &&
    owner.token.length > 0 &&
    Number.isFinite(Date.parse(owner.acquiredAt ?? ""))
  );
}

function isStaleLock(lockDir, owner) {
  if (isValidLockOwner(owner)) {
    return !isProcessAlive(owner.pid);
  }
  return lockAgeMilliseconds(lockDir, owner) >= STATE_LOCK_STALE_MS;
}

function releaseReaper(reaperFile, token) {
  try {
    const owner = JSON.parse(fs.readFileSync(reaperFile, "utf8"));
    if (owner.token === token) {
      fs.unlinkSync(reaperFile);
    }
  } catch {
    // A crashed or timed-out reaper may already have been reclaimed.
  }
}

function tryReapStaleLock(stateDir, lockDir) {
  const reaperFile = path.join(stateDir, STATE_LOCK_REAPER_FILE_NAME);
  const token = randomUUID();
  const owner = {
    pid: process.pid,
    token,
    acquiredAt: nowIso()
  };

  try {
    fs.writeFileSync(reaperFile, `${JSON.stringify(owner)}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }

    let existingOwner = null;
    try {
      existingOwner = JSON.parse(fs.readFileSync(reaperFile, "utf8"));
    } catch {
      // Use the file timestamp when a crashed writer left invalid metadata.
    }
    const reaperAge = (() => {
      const acquiredAt = Date.parse(existingOwner?.acquiredAt ?? "");
      if (Number.isFinite(acquiredAt)) {
        return Date.now() - acquiredAt;
      }
      try {
        return Date.now() - fs.statSync(reaperFile).mtimeMs;
      } catch {
        return 0;
      }
    })();
    const staleReaper = isValidLockOwner(existingOwner)
      ? !isProcessAlive(existingOwner.pid)
      : reaperAge >= STATE_LOCK_STALE_MS;
    if (staleReaper) {
      removeFileIfExists(reaperFile);
    }
    return false;
  }

  try {
    const currentOwner = readLockOwner(lockDir);
    if (fs.existsSync(lockDir) && isStaleLock(lockDir, currentOwner)) {
      fs.rmSync(lockDir, { recursive: true, force: true });
      return true;
    }
    return false;
  } finally {
    releaseReaper(reaperFile, token);
  }
}

function acquireStateLock(stateDir) {
  ensureStateDirPath(stateDir);
  const lockDir = path.join(stateDir, STATE_LOCK_DIR_NAME);
  const startedAt = Date.now();

  while (true) {
    const token = randomUUID();
    try {
      fs.mkdirSync(lockDir);
      atomicWriteFile(
        path.join(lockDir, STATE_LOCK_OWNER_FILE_NAME),
        `${JSON.stringify({ pid: process.pid, token, acquiredAt: nowIso() })}\n`
      );
      return { lockDir, token };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        try {
          fs.rmSync(lockDir, { recursive: true, force: true });
        } catch {
          // Preserve the original acquisition failure.
        }
        throw error;
      }
    }

    const owner = readLockOwner(lockDir);
    if (isStaleLock(lockDir, owner)) {
      if (tryReapStaleLock(stateDir, lockDir)) {
        continue;
      }
    }
    if (Date.now() - startedAt >= STATE_LOCK_ACQUIRE_TIMEOUT_MS) {
      throw new Error(`Timed out acquiring Codex companion state lock: ${lockDir}`);
    }
    sleepSync(STATE_LOCK_RETRY_MS);
  }
}

function releaseStateLock(lock) {
  const owner = readLockOwner(lock.lockDir);
  if (owner?.token !== lock.token) {
    return;
  }
  fs.rmSync(lock.lockDir, { recursive: true, force: true });
}

function withStateLock(cwd, operation) {
  const stateDir = resolveStateDir(cwd);
  const lock = acquireStateLock(stateDir);
  try {
    return operation(stateDir);
  } finally {
    releaseStateLock(lock);
  }
}

function loadStateFile(stateFile) {
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
}

export function loadState(cwd) {
  return loadStateFile(stateFileInDir(resolveStateDir(cwd)));
}

function pruneJobs(jobs) {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

function projectJobForIndex(job) {
  const indexRecord = { ...job };
  for (const field of JOB_INDEX_DETAIL_FIELDS) {
    delete indexRecord[field];
  }
  return indexRecord;
}

function overlayStoredJob(indexedJob, storedJob) {
  return storedJob == null
    ? indexedJob
    : projectJobForIndex({ ...indexedJob, ...storedJob, id: indexedJob.id });
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function saveStateLocked(stateDir, state, previousJobs) {
  const nextJobs = pruneJobs(state.jobs ?? []).map(projectJobForIndex);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  atomicWriteFile(stateFileInDir(stateDir), `${JSON.stringify(nextState, null, 2)}\n`);

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeArtifactBestEffort(jobFileInStateDir(stateDir, job.id));
    removeArtifactBestEffort(job.logFile);
  }
  return nextState;
}

// Compatibility API: replace the complete state snapshot. Read-modify-write callers must use updateState.
export function saveState(cwd, state) {
  return withStateLock(cwd, (stateDir) =>
    saveStateLocked(stateDir, state, loadStateFile(stateFileInDir(stateDir)).jobs)
  );
}

export function updateState(cwd, mutate) {
  return withStateLock(cwd, (stateDir) => {
    const state = loadStateFile(stateFileInDir(stateDir));
    const previousJobs = [...state.jobs];
    mutate(state);
    return saveStateLocked(stateDir, state, previousJobs);
  });
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    upsertJobInState(state, jobPatch);
  });
}

function upsertJobInState(state, jobPatch, timestamp = nowIso()) {
  const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
  if (existingIndex === -1) {
    state.jobs.unshift(
      projectJobForIndex({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      })
    );
    return;
  }
  state.jobs[existingIndex] = projectJobForIndex({
    ...state.jobs[existingIndex],
    ...jobPatch,
    updatedAt: timestamp
  });
}

function isTerminalJobStatus(status) {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function resolveCurrentJob(indexedJob, storedJob) {
  return storedJob == null ? indexedJob : { ...(indexedJob ?? {}), ...storedJob };
}

function readJobFileIfPresent(jobFile) {
  try {
    return readJobFile(jobFile);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function repairJobIndexFromStored(state, indexedJob, storedJob) {
  if (indexedJob == null || storedJob == null) {
    return false;
  }
  const repairedJob = overlayStoredJob(indexedJob, storedJob);
  if (isDeepStrictEqual(indexedJob, repairedJob)) {
    return false;
  }
  const index = state.jobs.findIndex((job) => job.id === indexedJob.id);
  if (index === -1) {
    return false;
  }
  state.jobs[index] = repairedJob;
  return true;
}

export function updateJobRecord(cwd, jobId, mutate) {
  return withStateLock(cwd, (stateDir) => {
    const state = loadStateFile(stateFileInDir(stateDir));
    const previousJobs = [...state.jobs];
    const indexedJob = state.jobs.find((job) => job.id === jobId) ?? null;
    const jobFile = jobFileInStateDir(stateDir, jobId);
    const storedJob = readJobFileIfPresent(jobFile);
    if (indexedJob == null && storedJob != null) {
      return null;
    }
    const currentJob = resolveCurrentJob(indexedJob, storedJob);
    const nextJob = mutate(currentJob, { indexedJob, storedJob });
    if (nextJob == null) {
      if (repairJobIndexFromStored(state, indexedJob, storedJob)) {
        saveStateLocked(stateDir, state, previousJobs);
      }
      return null;
    }
    if (typeof nextJob !== "object" || Array.isArray(nextJob)) {
      throw new TypeError("updateJobRecord mutate callback must return a job object or null");
    }
    if (isTerminalJobStatus(currentJob?.status) && nextJob.status !== currentJob.status) {
      if (repairJobIndexFromStored(state, indexedJob, storedJob)) {
        saveStateLocked(stateDir, state, previousJobs);
      }
      return null;
    }

    const timestamp = nowIso();
    const record = {
      createdAt: currentJob?.createdAt ?? timestamp,
      ...nextJob,
      id: jobId,
      updatedAt: timestamp
    };
    atomicWriteFile(jobFile, `${JSON.stringify(record, null, 2)}\n`);
    upsertJobInState(state, record, timestamp);
    saveStateLocked(stateDir, state, previousJobs);
    return record;
  });
}

export function listJobs(cwd) {
  const stateDir = resolveStateDir(cwd);
  const state = loadStateFile(stateFileInDir(stateDir));
  return state.jobs.map((indexedJob) =>
    overlayStoredJob(indexedJob, readJobFileIfPresent(jobFileInStateDir(stateDir, indexedJob.id)))
  );
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  const stateDir = resolveStateDir(cwd);
  ensureStateDirPath(stateDir);
  const jobFile = jobFileInStateDir(stateDir, jobId);
  atomicWriteFile(jobFile, `${JSON.stringify(payload, null, 2)}\n`);
  return jobFile;
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

function removeArtifactBestEffort(filePath) {
  try {
    removeFileIfExists(filePath);
  } catch {
    // The index is already committed; an orphan artifact must not abort cleanup.
  }
}

export function resolveJobLogFile(cwd, jobId) {
  const stateDir = resolveStateDir(cwd);
  ensureStateDirPath(stateDir);
  return path.join(jobsDirInStateDir(stateDir), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  const stateDir = resolveStateDir(cwd);
  ensureStateDirPath(stateDir);
  return jobFileInStateDir(stateDir, jobId);
}
