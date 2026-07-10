import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { makeTempDir } from "./helpers.mjs";
import {
  getConfig,
  listJobs,
  loadState,
  readJobFile,
  resolveJobFile,
  resolveJobLogFile,
  resolveStateDir,
  resolveStateFile,
  saveState,
  setConfig,
  updateJobRecord,
  updateState,
  upsertJob,
  writeJobFile
} from "../plugins/codex/scripts/lib/state.mjs";

const STATE_PROCESS_FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "state-process-fixture.mjs");

function waitForChild(child) {
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`State fixture exited with code ${code}, signal ${signal}: ${stderr}`));
    });
  });
}

async function waitForFiles(filePaths) {
  const deadline = Date.now() + 10_000;
  while (!filePaths.every((filePath) => fs.existsSync(filePath))) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for fixture files: ${filePaths.join(", ")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);

  assert.equal(stateDir.startsWith(os.tmpdir()), true);
  assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
  assert.match(stateDir, new RegExp(`^${os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("resolveStateDir uses CLAUDE_PLUGIN_DATA when it is provided", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(
      stateDir,
      new RegExp(`^${path.join(pluginDataDir, "state").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("saveState prunes dropped job artifacts when indexed jobs exceed the cap", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: 51 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    const jobFile = resolveJobFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "completed" }, null, 2), "utf8");
    return {
      id: jobId,
      status: "completed",
      logFile,
      updatedAt,
      createdAt: updatedAt
    };
  });

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs
  });

  const prunedJobFile = resolveJobFile(workspace, "job-0");
  const prunedLogFile = resolveJobLogFile(workspace, "job-0");
  const retainedJobFile = resolveJobFile(workspace, "job-50");
  const retainedLogFile = resolveJobLogFile(workspace, "job-50");
  const jobsDir = path.dirname(prunedJobFile);

  assert.equal(fs.existsSync(retainedJobFile), true);
  assert.equal(fs.existsSync(retainedLogFile), true);

  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(savedState.jobs.length, 50);
  assert.deepEqual(
    savedState.jobs.map((job) => job.id),
    Array.from({ length: 50 }, (_, index) => `job-${50 - index}`)
  );
  assert.deepEqual(
    fs.readdirSync(jobsDir).sort(),
    Array.from({ length: 50 }, (_, index) => `job-${index + 1}`)
      .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`])
      .sort()
  );
});

test("saveState remains a serialized full-snapshot replacement API", () => {
  const workspace = makeTempDir();
  upsertJob(workspace, { id: "original", status: "running" });
  const snapshot = loadState(workspace);

  upsertJob(workspace, { id: "concurrent", status: "running" });
  saveState(workspace, snapshot);

  assert.deepEqual(listJobs(workspace).map((job) => job.id), ["original"]);
});

test("state mutations release the cross-process lock after exceptions and recover stale owners", () => {
  const workspace = makeTempDir();
  const lockDir = path.join(resolveStateDir(workspace), ".state.lock");

  assert.throws(
    () => updateState(workspace, () => {
      throw new Error("fixture mutation failed");
    }),
    /fixture mutation failed/
  );
  assert.equal(fs.existsSync(lockDir), false);

  fs.mkdirSync(lockDir);
  fs.writeFileSync(
    path.join(lockDir, "owner.json"),
    `${JSON.stringify({ pid: 2_147_483_647, token: "dead-owner", acquiredAt: new Date().toISOString() })}\n`,
    "utf8"
  );
  setConfig(workspace, "recoveredDeadOwner", true);
  assert.equal(getConfig(workspace).recoveredDeadOwner, true);

  fs.mkdirSync(lockDir);
  fs.writeFileSync(
    path.join(lockDir, "owner.json"),
    `${JSON.stringify({ pid: process.pid, acquiredAt: "2000-01-01T00:00:00.000Z" })}\n`,
    "utf8"
  );
  setConfig(workspace, "recoveredInvalidOwner", true);
  assert.equal(getConfig(workspace).recoveredInvalidOwner, true);
  assert.equal(fs.existsSync(lockDir), false);
});

test("an old lock with a live cross-process owner is never reclaimed", async (t) => {
  const workspace = makeTempDir();
  const lockDir = path.join(resolveStateDir(workspace), ".state.lock");
  const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore"
  });
  await new Promise((resolve, reject) => {
    owner.once("spawn", resolve);
    owner.once("error", reject);
  });
  t.after(() => {
    if (owner.exitCode === null) {
      owner.kill("SIGTERM");
    }
  });

  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(
    path.join(lockDir, "owner.json"),
    `${JSON.stringify({ pid: owner.pid, token: "live-owner", acquiredAt: "2000-01-01T00:00:00.000Z" })}\n`,
    "utf8"
  );

  const contender = spawn(
    process.execPath,
    [STATE_PROCESS_FIXTURE, "set-config", workspace, "unused", "liveOwnerReleased", "yes"],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
  let contenderExited = false;
  contender.once("exit", () => {
    contenderExited = true;
  });
  const contenderCompletion = waitForChild(contender);
  await new Promise((resolve) => setTimeout(resolve, 250));

  assert.equal(contenderExited, false);
  assert.equal(fs.existsSync(lockDir), true);

  const ownerExit = new Promise((resolve) => owner.once("exit", resolve));
  owner.kill("SIGTERM");
  await ownerExit;
  await contenderCompletion;
  assert.equal(getConfig(workspace).liveOwnerReleased, "yes");
});

test("independent processes do not lose concurrent job upserts", async () => {
  const workspace = makeTempDir();
  const signalFile = path.join(workspace, "start-upserts");
  const countPerProcess = 24;
  const children = ["left", "right"].map((identity) =>
    spawn(process.execPath, [STATE_PROCESS_FIXTURE, "upsert", workspace, signalFile, identity, String(countPerProcess)], {
      stdio: ["ignore", "ignore", "pipe"]
    })
  );
  const completions = children.map(waitForChild);

  await waitForFiles(children.map((_, index) => `${signalFile}.${index === 0 ? "left" : "right"}.ready`));
  fs.writeFileSync(signalFile, "start\n", "utf8");
  await Promise.all(completions);

  const jobs = listJobs(workspace);
  assert.equal(jobs.length, countPerProcess * 2);
  assert.deepEqual(
    new Set(jobs.map((job) => job.id)),
    new Set(
      ["left", "right"].flatMap((identity) =>
        Array.from({ length: countPerProcess }, (_, index) => `${identity}-${index}`)
      )
    )
  );
});

test("a concurrent stale running transition cannot resurrect a terminal job", async () => {
  const workspace = makeTempDir();
  const signalFile = path.join(workspace, "start-transitions");
  const initial = { id: "transition-job", status: "running", source: "initial" };
  writeJobFile(workspace, initial.id, initial);
  upsertJob(workspace, initial);

  const transitions = [
    { identity: "terminal-writer", status: "cancelled", delay: "0" },
    { identity: "stale-worker", status: "running", delay: "100" }
  ];
  const children = transitions.map(({ identity, status, delay }) =>
    spawn(
      process.execPath,
      [STATE_PROCESS_FIXTURE, "transition", workspace, signalFile, identity, status, delay],
      { stdio: ["ignore", "ignore", "pipe"] }
    )
  );
  const completions = children.map(waitForChild);

  await waitForFiles(transitions.map(({ identity }) => `${signalFile}.${identity}.ready`));
  fs.writeFileSync(signalFile, "start\n", "utf8");
  await Promise.all(completions);

  const indexed = listJobs(workspace).find((job) => job.id === initial.id);
  const stored = readJobFile(resolveJobFile(workspace, initial.id));
  assert.equal(indexed.status, "cancelled");
  assert.equal(stored.status, "cancelled");
});

test("job transitions keep detail payloads out of the state index", () => {
  const workspace = makeTempDir();
  const record = updateJobRecord(workspace, "detail-job", () => ({
    id: "detail-job",
    status: "completed",
    summary: "compact index field",
    request: { prompt: "large prompt" },
    result: { rawOutput: "large result" },
    rendered: "large rendered report"
  }));

  assert.deepEqual(record.request, { prompt: "large prompt" });
  assert.deepEqual(readJobFile(resolveJobFile(workspace, record.id)), record);
  const indexed = listJobs(workspace).find((job) => job.id === record.id);
  assert.equal(indexed.summary, "compact index field");
  assert.equal(Object.hasOwn(indexed, "request"), false);
  assert.equal(Object.hasOwn(indexed, "result"), false);
  assert.equal(Object.hasOwn(indexed, "rendered"), false);
});

test("per-job state remains authoritative when the index rename fails", () => {
  const workspace = makeTempDir();
  const jobId = "rename-gap-job";
  const stateFile = resolveStateFile(workspace);
  updateJobRecord(workspace, jobId, () => ({ id: jobId, status: "running", summary: "before" }));

  const originalRenameSync = fs.renameSync;
  let injectedFailure = false;
  fs.renameSync = (source, destination) => {
    if (!injectedFailure && destination === stateFile) {
      injectedFailure = true;
      const error = new Error("injected state index rename failure");
      error.code = "EIO";
      throw error;
    }
    return originalRenameSync(source, destination);
  };
  try {
    assert.throws(
      () => updateJobRecord(workspace, jobId, (current) => ({ ...current, status: "completed", summary: "after" })),
      /injected state index rename failure/
    );
  } finally {
    fs.renameSync = originalRenameSync;
  }

  assert.equal(readJobFile(resolveJobFile(workspace, jobId)).status, "completed");
  assert.equal(loadState(workspace).jobs[0].status, "running");
  assert.equal(listJobs(workspace)[0].status, "completed");

  assert.equal(updateJobRecord(workspace, jobId, () => null), null);
  assert.equal(loadState(workspace).jobs[0].status, "completed");
  assert.equal(loadState(workspace).jobs[0].summary, "after");
});

test("artifact deletion failures do not abort cleanup or re-index orphan job files", () => {
  const workspace = makeTempDir();
  const jobId = "orphan-cleanup-job";
  const jobFile = resolveJobFile(workspace, jobId);
  const logFile = resolveJobLogFile(workspace, jobId);
  fs.writeFileSync(logFile, "log\n", "utf8");
  updateJobRecord(workspace, jobId, () => ({ id: jobId, status: "completed", logFile }));

  const originalUnlinkSync = fs.unlinkSync;
  fs.unlinkSync = (filePath) => {
    if (filePath === jobFile) {
      const error = new Error("injected job artifact deletion failure");
      error.code = "EACCES";
      throw error;
    }
    return originalUnlinkSync(filePath);
  };
  try {
    updateState(workspace, (state) => {
      state.jobs = [];
    });
  } finally {
    fs.unlinkSync = originalUnlinkSync;
  }

  assert.equal(fs.existsSync(jobFile), true);
  assert.equal(fs.existsSync(logFile), false);
  assert.equal(updateJobRecord(workspace, jobId, (current) => ({ ...current, status: "running" })), null);
  assert.deepEqual(listJobs(workspace), []);
});

test("atomic state and per-job writes never expose partial JSON to readers", async () => {
  const workspace = makeTempDir();
  const doneFile = path.join(workspace, "atomic-writer-done");
  const payloadSize = 256 * 1024;
  const iterations = 80;
  const stateFile = resolveStateFile(workspace);
  const jobFile = resolveJobFile(workspace, "atomic-job");
  const initialPayload = "a".repeat(payloadSize);
  writeJobFile(workspace, "atomic-job", {
    id: "atomic-job",
    generation: 0,
    payload: initialPayload,
    status: "running"
  });
  setConfig(workspace, "atomicPayload", { generation: 0, payload: initialPayload });

  const child = spawn(
    process.execPath,
    [STATE_PROCESS_FIXTURE, "atomic-writer", workspace, doneFile, "writer", String(iterations), String(payloadSize)],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
  const completion = waitForChild(child);
  const deadline = Date.now() + 15_000;
  let reads = 0;

  while (!fs.existsSync(doneFile)) {
    assert.ok(Date.now() < deadline, "timed out while reading atomic state updates");
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
    for (const record of [state.config.atomicPayload, job]) {
      const expectedCharacter = record.generation % 2 === 0 ? "a" : "b";
      assert.equal(record.payload.length, payloadSize);
      assert.equal(record.payload, expectedCharacter.repeat(payloadSize));
    }
    reads += 1;
  }

  await completion;
  assert.ok(reads > 0);
  const temporaryFiles = [
    ...fs.readdirSync(resolveStateDir(workspace)),
    ...fs.readdirSync(path.dirname(jobFile))
  ].filter((entry) => entry.endsWith(".tmp"));
  assert.equal(
    temporaryFiles.length,
    0
  );
});
