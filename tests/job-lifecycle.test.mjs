import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { buildStatusSnapshot } from "../plugins/codex/scripts/lib/job-control.mjs";
import { renderJobStatusReport } from "../plugins/codex/scripts/lib/render.mjs";
import {
  listJobs,
  readJobFile,
  resolveJobFile,
  resolveJobLogFile,
  updateState,
  upsertJob,
  writeJobFile
} from "../plugins/codex/scripts/lib/state.mjs";
import { createJobProgressUpdater, runTrackedJob } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";
import { makeTempDir } from "./helpers.mjs";

test("status archives an active job when its recorded worker no longer exists", () => {
  const workspace = makeTempDir();
  const jobId = "task-dead-worker";
  const logFile = resolveJobLogFile(workspace, jobId);
  const lastActivityAt = "2026-07-10T01:00:00.000Z";
  const job = {
    id: jobId,
    status: "running",
    phase: "running",
    title: "Codex Task",
    jobClass: "task",
    workspaceRoot: workspace,
    pid: 4242,
    workerPid: 4242,
    lastActivityAt,
    logFile,
    request: { prompt: "diagnose the hang" }
  };
  fs.writeFileSync(logFile, "", "utf8");
  writeJobFile(workspace, jobId, job);
  upsertJob(workspace, job);

  const probed = [];
  const snapshot = buildStatusSnapshot(workspace, {
    env: {},
    isProcessRunning(pid) {
      probed.push(pid);
      return false;
    }
  });

  assert.deepEqual(probed, [4242]);
  assert.deepEqual(snapshot.running, []);
  assert.equal(snapshot.latestFinished.id, jobId);
  assert.equal(snapshot.latestFinished.status, "failed");
  assert.equal(snapshot.latestFinished.workerAlive, false);
  assert.equal(snapshot.latestFinished.workerPid, 4242);
  assert.equal(snapshot.latestFinished.lastActivityAt, lastActivityAt);
  assert.match(snapshot.latestFinished.errorMessage, /Worker process 4242 is no longer running/);

  const indexed = listJobs(workspace).find((candidate) => candidate.id === jobId);
  const stored = readJobFile(resolveJobFile(workspace, jobId));
  assert.equal(indexed.status, "failed");
  assert.equal(indexed.pid, null);
  assert.equal(stored.status, "failed");
  assert.deepEqual(stored.request, job.request);
  assert.match(fs.readFileSync(logFile, "utf8"), /Archived the job as failed/);
});

test("status keeps an active job while its worker is alive", () => {
  const workspace = makeTempDir();
  const jobId = "task-live-worker";
  const job = {
    id: jobId,
    status: "running",
    title: "Codex Task",
    jobClass: "task",
    workspaceRoot: workspace,
    pid: 5252,
    workerPid: 5252,
    lastActivityAt: new Date().toISOString()
  };
  writeJobFile(workspace, jobId, job);
  upsertJob(workspace, job);

  const snapshot = buildStatusSnapshot(workspace, {
    env: {},
    isProcessRunning: () => true
  });

  assert.equal(snapshot.running.length, 1);
  assert.equal(snapshot.running[0].id, jobId);
  assert.equal(snapshot.running[0].workerAlive, true);
  assert.equal(snapshot.latestFinished, null);
});

test("status does not apply a stale liveness result after the worker PID changes", () => {
  const workspace = makeTempDir();
  const jobId = "task-worker-handoff";
  const job = {
    id: jobId,
    status: "running",
    title: "Codex Task",
    jobClass: "task",
    workspaceRoot: workspace,
    pid: 6001,
    workerPid: 6001
  };
  writeJobFile(workspace, jobId, job);
  upsertJob(workspace, job);

  const snapshot = buildStatusSnapshot(workspace, {
    env: {},
    isProcessRunning(pid) {
      assert.equal(pid, 6001);
      const replacement = { ...readJobFile(resolveJobFile(workspace, jobId)), pid: 6002, workerPid: 6002 };
      writeJobFile(workspace, jobId, replacement);
      upsertJob(workspace, { id: jobId, pid: 6002, workerPid: 6002 });
      return false;
    }
  });

  assert.equal(snapshot.running[0].id, jobId);
  assert.equal(Object.hasOwn(snapshot.running[0], "workerAlive"), false);
});

test("status gives a newly queued job time to publish its worker PID", () => {
  const workspace = makeTempDir();
  const jobId = "task-starting-without-pid";
  const logFile = resolveJobLogFile(workspace, jobId);
  const job = {
    id: jobId,
    status: "queued",
    title: "Codex Task",
    jobClass: "task",
    workspaceRoot: workspace,
    createdAt: "2026-07-10T01:00:00.000Z",
    logFile
  };
  fs.writeFileSync(logFile, "", "utf8");
  writeJobFile(workspace, jobId, job);
  upsertJob(workspace, job);

  const withinGrace = buildStatusSnapshot(workspace, {
    env: {},
    now: "2026-07-10T01:00:29.999Z",
    missingWorkerGraceMs: 30_000,
    isProcessRunning() {
      throw new Error("A missing PID must not be probed.");
    }
  });
  assert.equal(withinGrace.running[0].id, jobId);
  assert.equal(withinGrace.running[0].workerAlive, null);

  const afterGrace = buildStatusSnapshot(workspace, {
    env: {},
    now: "2026-07-10T01:00:30.001Z",
    missingWorkerGraceMs: 30_000,
    isProcessRunning() {
      throw new Error("A missing PID must not be probed.");
    }
  });
  assert.deepEqual(afterGrace.running, []);
  assert.equal(afterGrace.latestFinished.status, "failed");
  assert.equal(afterGrace.latestFinished.completedAt, "2026-07-10T01:00:30.001Z");
  assert.match(afterGrace.latestFinished.errorMessage, /No worker PID was recorded within the 30000ms startup grace period/);
});

test("status immediately rejects an active job with neither a worker PID nor a startup timestamp", () => {
  const workspace = makeTempDir();
  const jobId = "task-invalid-startup-record";
  const job = {
    id: jobId,
    status: "running",
    title: "Codex Task",
    jobClass: "task",
    workspaceRoot: workspace,
    createdAt: "invalid"
  };
  writeJobFile(workspace, jobId, job);
  upsertJob(workspace, job);

  const snapshot = buildStatusSnapshot(workspace, {
    env: {},
    now: "2026-07-10T01:00:00.000Z"
  });

  assert.deepEqual(snapshot.running, []);
  assert.equal(snapshot.latestFinished.workerAlive, false);
  assert.match(snapshot.latestFinished.errorMessage, /No worker PID or valid startup timestamp was recorded/);
});

test("status reports a live worker without changing the last real activity", async () => {
  const workspace = makeTempDir();
  const jobId = "task-heartbeat";
  let finishRunner;
  const runnerResult = new Promise((resolve) => {
    finishRunner = resolve;
  });

  const executionPromise = runTrackedJob(
    {
      id: jobId,
      title: "Codex Task",
      jobClass: "task",
      workspaceRoot: workspace
    },
    () => runnerResult
  );
  const started = readJobFile(resolveJobFile(workspace, jobId));
  await new Promise((resolve) => setTimeout(resolve, 10));

  const observable = buildStatusSnapshot(workspace, {
    env: {},
    isProcessRunning: () => true
  }).running[0];
  assert.equal(observable.workerAlive, true);
  assert.equal(observable.lastActivityAt, started.lastActivityAt);
  assert.equal(Object.hasOwn(observable, "lastHeartbeatAt"), false);

  finishRunner({
    exitStatus: 0,
    threadId: "thread-heartbeat",
    turnId: "turn-heartbeat",
    payload: { ok: true },
    rendered: "done\n",
    summary: "done"
  });
  await executionPromise;

  const completed = readJobFile(resolveJobFile(workspace, jobId));
  assert.equal(completed.status, "completed");
  assert.equal(completed.pid, null);
  assert.equal(completed.workerPid, process.pid);
  assert.ok(Date.parse(completed.lastActivityAt) >= Date.parse(started.lastActivityAt));
});

test("a detached runner cannot recreate an orphaned per-job file after its index is removed", async () => {
  const workspace = makeTempDir();
  const jobId = "task-removed-before-worker-start";
  writeJobFile(workspace, jobId, {
    id: jobId,
    status: "queued",
    workspaceRoot: workspace,
    request: { prompt: "must not run" }
  });
  let runnerCalled = false;

  await assert.rejects(
    runTrackedJob(
      {
        id: jobId,
        title: "Codex Task",
        jobClass: "task",
        workspaceRoot: workspace
      },
      async () => {
        runnerCalled = true;
        return { exitStatus: 0, payload: {}, rendered: "", summary: "" };
      },
      { requireExisting: true }
    ),
    /is no longer active/
  );

  assert.equal(runnerCalled, false);
  assert.deepEqual(listJobs(workspace), []);
  assert.equal(readJobFile(resolveJobFile(workspace, jobId)).status, "queued");
});

test("a detached runner cannot re-index an orphan after cleanup races with completion", async () => {
  const workspace = makeTempDir();
  const jobId = "task-removed-before-worker-completion";
  const jobFile = resolveJobFile(workspace, jobId);
  const queued = {
    id: jobId,
    status: "queued",
    title: "Codex Task",
    jobClass: "task",
    workspaceRoot: workspace
  };
  writeJobFile(workspace, jobId, queued);
  upsertJob(workspace, queued);

  await runTrackedJob(
    queued,
    async () => {
      const originalUnlinkSync = fs.unlinkSync;
      fs.unlinkSync = (filePath) => {
        if (filePath === jobFile) {
          throw new Error("injected artifact cleanup failure");
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
      createJobProgressUpdater(workspace, jobId)({ message: "late worker progress", phase: "running" });
      return { exitStatus: 0, payload: { ok: true }, rendered: "done\n", summary: "done" };
    },
    { requireExisting: true }
  );

  assert.deepEqual(listJobs(workspace), []);
  assert.equal(readJobFile(jobFile).status, "running");
});

test("progress events update activity even when phase and turn identifiers do not change", async () => {
  const workspace = makeTempDir();
  const jobId = "task-progress-activity";
  const initial = {
    id: jobId,
    status: "running",
    phase: "running",
    workspaceRoot: workspace,
    lastActivityAt: "2026-07-10T01:00:00.000Z"
  };
  writeJobFile(workspace, jobId, initial);
  upsertJob(workspace, initial);
  const updateProgress = createJobProgressUpdater(workspace, jobId);

  updateProgress({ message: "first", phase: "running", threadId: "thread-1", turnId: "turn-1" });
  const firstActivityAt = readJobFile(resolveJobFile(workspace, jobId)).lastActivityAt;
  await new Promise((resolve) => setTimeout(resolve, 2));
  updateProgress({ message: "second", phase: "running", threadId: "thread-1", turnId: "turn-1" });
  const secondActivityAt = readJobFile(resolveJobFile(workspace, jobId)).lastActivityAt;

  assert.notEqual(firstActivityAt, initial.lastActivityAt);
  assert.ok(Date.parse(secondActivityAt) > Date.parse(firstActivityAt));
  assert.equal(listJobs(workspace)[0].lastActivityAt, secondActivityAt);
});

test("a tracked runner cannot overwrite a terminal state written by cancellation", async () => {
  const workspace = makeTempDir();
  const jobId = "task-cancel-race";

  await runTrackedJob(
    {
      id: jobId,
      title: "Codex Task",
      jobClass: "task",
      workspaceRoot: workspace
    },
    async () => {
      const running = readJobFile(resolveJobFile(workspace, jobId));
      writeJobFile(workspace, jobId, {
        ...running,
        status: "cancelled",
        phase: "cancelled",
        pid: null
      });
      upsertJob(workspace, {
        id: jobId,
        status: "cancelled",
        phase: "cancelled",
        pid: null
      });
      return {
        exitStatus: 0,
        payload: { ok: true },
        rendered: "runner returned after interrupt\n",
        summary: "runner returned"
      };
    }
  );

  assert.equal(readJobFile(resolveJobFile(workspace, jobId)).status, "cancelled");
  assert.equal(listJobs(workspace)[0].status, "cancelled");
});

test("job status output separates worker liveness from the last activity", () => {
  const rendered = renderJobStatusReport({
    id: "task-visible-heartbeat",
    status: "running",
    title: "Codex Task",
    lastActivityAt: "2026-07-10T01:00:00.000Z",
    lastActivityAgo: "12s",
    workerAlive: true
  });

  assert.match(rendered, /Last activity: 2026-07-10T01:00:00\.000Z \(12s ago\)/);
  assert.match(rendered, /Worker process: alive/);
});
