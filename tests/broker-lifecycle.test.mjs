import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { BROKER_ENDPOINT_ENV, CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import { createBrokerEndpoint, parseBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.mjs";
import {
  BROKER_IDLE_TTL_ENV,
  clearBrokerSession,
  ensureBrokerSession,
  loadBrokerSession,
  saveBrokerSession,
  sendBrokerShutdown,
  teardownBrokerSession,
  waitForBrokerEndpoint
} from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";
import { buildStatusSnapshot } from "../plugins/codex/scripts/lib/job-control.mjs";
import { listJobs, resolveStateDir, upsertJob } from "../plugins/codex/scripts/lib/state.mjs";
import { SESSION_ID_ENV } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BROKER_SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "app-server-broker.mjs");
const SESSION_HOOK = path.join(ROOT, "plugins", "codex", "scripts", "session-lifecycle-hook.mjs");
const ENSURE_BROKER_FIXTURE = path.join(ROOT, "tests", "ensure-broker-fixture.mjs");

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for broker state.");
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function cleanupEnsuredBroker(repo) {
  const session = loadBrokerSession(repo);
  if (!session) {
    return;
  }
  await sendBrokerShutdown(session.endpoint, 300).catch(() => false);
  teardownBrokerSession({
    ...session,
    killProcess: terminateProcessTree
  });
  clearBrokerSession(repo);
}

function ensureBrokerInChild(cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENSURE_BROKER_FIXTURE, cwd, "5000"], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("ensure broker fixture timed out"));
    }, 15_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr || `ensure broker fixture exited with ${code}`));
        return;
      }
      resolve(JSON.parse(stdout));
    });
  });
}

async function startBroker(
  t,
  { behavior = "review-ok", idleTtlMs = 5000, interruptGraceMs = null } = {}
) {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const sessionDir = makeTempDir("cxc-broker-test-");
  const endpoint = createBrokerEndpoint(sessionDir);
  const pidFile = path.join(sessionDir, "broker.pid");
  installFakeCodex(binDir, behavior);
  initGitRepo(repo);

  const child = spawn(
    process.execPath,
    [BROKER_SCRIPT, "serve", "--endpoint", endpoint, "--cwd", repo, "--pid-file", pidFile],
    {
      cwd: repo,
      env: {
        ...buildEnv(binDir),
        [BROKER_IDLE_TTL_ENV]: String(idleTtlMs),
        ...(interruptGraceMs == null
          ? {}
          : { CODEX_COMPANION_BROKER_INTERRUPT_GRACE_MS: String(interruptGraceMs) })
      },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  t.after(async () => {
    await sendBrokerShutdown(endpoint, 300).catch(() => false);
    if (processExists(child.pid)) {
      child.kill("SIGTERM");
    }
    await waitFor(() => !processExists(child.pid), 1000).catch(() => false);
    if (processExists(child.pid)) {
      child.kill("SIGKILL");
    }
  });

  assert.equal(await waitForBrokerEndpoint(endpoint, 2000), true, stderr);
  return { repo, binDir, sessionDir, endpoint, pidFile, child, getStderr: () => stderr };
}

function connectRpc(endpoint) {
  const target = parseBrokerEndpoint(endpoint);
  const socket = net.createConnection({ path: target.path });
  socket.setEncoding("utf8");
  let nextId = 1;
  let buffer = "";
  const pending = new Map();

  socket.on("data", (chunk) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
      if (!line.trim()) {
        continue;
      }
      const message = JSON.parse(line);
      if (message.id !== undefined && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) {
          reject(new Error(message.error.message));
        } else {
          resolve(message.result ?? {});
        }
      }
    }
  });

  return {
    ready: new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    }),
    request(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    },
    destroy() {
      socket.destroy();
    }
  };
}

async function startActiveTurn(client, repo) {
  await client.ready;
  await client.request("initialize", { clientInfo: {}, capabilities: {} });
  const startedThread = await client.request("thread/start", { cwd: repo, ephemeral: true });
  const threadId = startedThread.thread.id;
  const startedTurn = await client.request("turn/start", {
    threadId,
    input: [{ type: "text", text: "keep running until interrupted", text_elements: [] }]
  });
  return { threadId, turnId: startedTurn.turn.id };
}

test("broker readiness requires a bounded protocol health response", async (t) => {
  const sessionDir = makeTempDir("cxc-silent-broker-");
  const endpoint = createBrokerEndpoint(sessionDir);
  const target = parseBrokerEndpoint(endpoint);
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(target.path, resolve));
  t.after(() => {
    for (const socket of sockets) {
      socket.destroy();
    }
    server.close();
  });

  const startedAt = Date.now();
  assert.equal(await waitForBrokerEndpoint(endpoint, 120), false);
  assert.ok(Date.now() - startedAt < 1000);

  const shutdownStartedAt = Date.now();
  assert.equal(await sendBrokerShutdown(endpoint, 80), false);
  assert.ok(Date.now() - shutdownStartedAt < 1000);
});

test("trusted worktree state keeps a healthy legacy broker", async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const sessionDir = makeTempDir("cxc-legacy-broker-");
  const endpoint = createBrokerEndpoint(sessionDir);
  const target = parseBrokerEndpoint(endpoint);
  const sockets = new Set();
  installFakeCodex(binDir);
  initGitRepo(repo);
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        const message = JSON.parse(line);
        if (message.method === "broker/health") {
          socket.write(`${JSON.stringify({ id: message.id, result: { status: "ok" } })}\n`);
        } else if (message.method === "broker/shutdown") {
          socket.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
        }
      }
    });
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(target.path, resolve));
  saveBrokerSession(repo, { endpoint, pid: null, legacyMarker: true });
  t.after(async () => {
    await cleanupEnsuredBroker(repo);
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise((resolve) => server.close(resolve));
  });

  assert.equal(await waitForBrokerEndpoint(endpoint, 80, repo), false);
  assert.equal(await waitForBrokerEndpoint(endpoint, 80, repo, { allowMissingWorkspace: true }), true);
  const session = await ensureBrokerSession(repo, { env: buildEnv(binDir), timeoutMs: 500 });
  assert.equal(session.legacyMarker, true);
  assert.equal(session.endpoint, endpoint);
  assert.equal(fs.existsSync(path.join(binDir, "fake-codex-state.json")), false);
});

test("concurrent ensure calls share one broker", async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  t.after(() => cleanupEnsuredBroker(repo));

  const env = { ...buildEnv(binDir), [BROKER_IDLE_TTL_ENV]: "5000" };
  const [first, second] = await Promise.all([
    ensureBrokerInChild(repo, env),
    ensureBrokerInChild(repo, env)
  ]);

  assert.ok(first);
  assert.ok(second);
  assert.equal(first.pid, second.pid);
  assert.equal(first.endpoint, second.endpoint);
  const fakeState = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.equal(fakeState.appServerStarts, 1);
  assert.equal(fs.existsSync(path.join(resolveStateDir(repo), "broker.lock")), false);
});

test("ensure reclaims a lock whose owner no longer exists", async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  t.after(() => cleanupEnsuredBroker(repo));

  const stateDir = resolveStateDir(repo);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "broker.lock"),
    `${JSON.stringify({ pid: 2_147_483_647, token: "dead-owner", createdAt: Date.now() })}\n`,
    "utf8"
  );

  const session = await ensureBrokerSession(repo, {
    env: { ...buildEnv(binDir), [BROKER_IDLE_TTL_ENV]: "5000" },
    timeoutMs: 5000,
    staleLockTimeoutMs: 60_000
  });
  assert.ok(session);
  assert.equal(fs.existsSync(path.join(stateDir, "broker.lock")), false);
});

test("ensure never steals an old lock from a live owner", async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  const stateDir = resolveStateDir(repo);
  const lockFile = path.join(stateDir, "broker.lock");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    lockFile,
    `${JSON.stringify({ pid: process.pid, token: "live-owner", createdAt: "2000-01-01T00:00:00.000Z" })}\n`,
    "utf8"
  );
  fs.utimesSync(lockFile, new Date(0), new Date(0));
  t.after(() => {
    if (fs.existsSync(lockFile)) {
      fs.unlinkSync(lockFile);
    }
  });

  const session = await ensureBrokerSession(repo, {
    env: buildEnv(binDir),
    lockWaitTimeoutMs: 50,
    staleLockTimeoutMs: 10,
    lockRetryIntervalMs: 5
  });
  assert.equal(session, null);
  assert.equal(fs.existsSync(lockFile), true);
  assert.equal(fs.existsSync(path.join(binDir, "fake-codex-state.json")), false);
});

test("git worktrees keep broker, state, and session jobs isolated", async (t) => {
  const primary = makeTempDir();
  const worktreeParent = makeTempDir();
  const secondary = path.join(worktreeParent, "feature-worktree");
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(primary);
  fs.writeFileSync(path.join(primary, "README.md"), "primary\n", "utf8");
  run("git", ["add", "README.md"], { cwd: primary });
  run("git", ["commit", "-m", "initial"], { cwd: primary });
  const addedWorktree = run("git", ["worktree", "add", "-b", "feature", secondary], { cwd: primary });
  assert.equal(addedWorktree.status, 0, addedWorktree.stderr);
  t.after(async () => {
    await cleanupEnsuredBroker(secondary);
    await cleanupEnsuredBroker(primary);
  });

  const brokerEnv = { ...buildEnv(binDir), [BROKER_IDLE_TTL_ENV]: "5000" };
  const primarySession = await ensureBrokerSession(primary, { env: brokerEnv, timeoutMs: 5000 });
  assert.ok(primarySession);

  upsertJob(primary, { id: "primary-ending", status: "completed", sessionId: "sess-ending" });
  upsertJob(primary, {
    id: "primary-other-active",
    status: "running",
    sessionId: "sess-other",
    pid: process.pid,
    workerPid: process.pid
  });
  const primarySessionEnd = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: primary,
    env: { ...brokerEnv, [BROKER_ENDPOINT_ENV]: primarySession.endpoint },
    input: JSON.stringify({ hook_event_name: "SessionEnd", cwd: primary, session_id: "sess-ending" })
  });
  assert.equal(primarySessionEnd.status, 0, primarySessionEnd.stderr);
  assert.equal(await waitForBrokerEndpoint(primarySession.endpoint, 150, primary), true);
  assert.deepEqual(listJobs(primary).map((job) => job.id), ["primary-other-active"]);

  const staleEndpointEnv = { ...brokerEnv, [BROKER_ENDPOINT_ENV]: primarySession.endpoint };
  const secondarySessionEnd = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: secondary,
    env: staleEndpointEnv,
    input: JSON.stringify({ hook_event_name: "SessionEnd", cwd: secondary, session_id: "sess-current" })
  });
  assert.equal(secondarySessionEnd.status, 0, secondarySessionEnd.stderr);
  assert.equal(await waitForBrokerEndpoint(primarySession.endpoint, 150, primary), true);
  const secondaryBeforeFirstUse = buildStatusSnapshot(secondary, {
    env: { ...staleEndpointEnv, [SESSION_ID_ENV]: "sess-current" }
  });
  assert.equal(secondaryBeforeFirstUse.sessionRuntime.mode, "direct");
  assert.equal(secondaryBeforeFirstUse.sessionRuntime.endpoint, null);

  const secondaryClient = await CodexAppServerClient.connect(secondary, {
    env: staleEndpointEnv
  });
  assert.equal(secondaryClient.transport, "broker");
  await secondaryClient.close();

  const secondarySession = loadBrokerSession(secondary);
  assert.ok(secondarySession);
  assert.notEqual(resolveStateDir(primary), resolveStateDir(secondary));
  assert.notEqual(primarySession.endpoint, secondarySession.endpoint);
  assert.equal(secondaryClient.endpoint, secondarySession.endpoint);
  assert.equal(await waitForBrokerEndpoint(primarySession.endpoint, 150, primary), true);
  assert.equal(await waitForBrokerEndpoint(primarySession.endpoint, 150, secondary), false);

  upsertJob(primary, { id: "primary-other-active", status: "completed", sessionId: "sess-other" });
  upsertJob(primary, { id: "primary-current", status: "completed", sessionId: "sess-current" });
  upsertJob(secondary, { id: "secondary-current", status: "completed", sessionId: "sess-current" });
  upsertJob(secondary, { id: "secondary-other", status: "completed", sessionId: "sess-other" });
  const statusOptions = {
    env: { ...staleEndpointEnv, [SESSION_ID_ENV]: "sess-current" },
    all: true
  };
  const primaryStatus = buildStatusSnapshot(primary, statusOptions);
  const secondaryStatus = buildStatusSnapshot(secondary, statusOptions);
  const visibleJobIds = (snapshot) => [
    ...snapshot.running.map((job) => job.id),
    snapshot.latestFinished?.id,
    ...snapshot.recent.map((job) => job.id)
  ].filter(Boolean);
  assert.deepEqual(visibleJobIds(primaryStatus), ["primary-current"]);
  assert.deepEqual(visibleJobIds(secondaryStatus), ["secondary-current"]);
  assert.equal(primaryStatus.sessionRuntime.endpoint, primarySession.endpoint);
  assert.equal(secondaryStatus.sessionRuntime.endpoint, secondarySession.endpoint);

  const fakeState = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.equal(fakeState.appServerStarts, 2);
});

test("idle broker exits after its last client disconnects", async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  t.after(() => cleanupEnsuredBroker(repo));

  const session = await ensureBrokerSession(repo, {
    env: { ...buildEnv(binDir), [BROKER_IDLE_TTL_ENV]: "100" },
    timeoutMs: 5000
  });
  assert.ok(session);

  await waitFor(() => !processExists(session.pid), 3000);
  const stoppedSession = loadBrokerSession(repo);
  assert.equal(stoppedSession.pid, null);
  assert.ok(stoppedSession.stoppedAt);
  assert.equal(buildStatusSnapshot(repo, { env: {} }).sessionRuntime.mode, "direct");
  assert.equal(fs.existsSync(session.pidFile), false);
  if (process.platform !== "win32") {
    assert.equal(fs.existsSync(parseBrokerEndpoint(session.endpoint).path), false);
  }
});

test("disconnecting the owner interrupts its active turn", async (t) => {
  const broker = await startBroker(t, { behavior: "interruptible-slow-task" });
  const client = connectRpc(broker.endpoint);
  const { threadId, turnId } = await startActiveTurn(client, broker.repo);

  client.destroy();

  const fakeStatePath = path.join(broker.binDir, "fake-codex-state.json");
  const interrupt = await waitFor(() => {
    const state = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
    return state.lastInterrupt ?? null;
  });
  assert.deepEqual(interrupt, { threadId, turnId });
});

test("interrupt ACK keeps the orphan stream busy until terminal completion", async (t) => {
  const broker = await startBroker(t, {
    behavior: "interrupt-ack-before-completion",
    idleTtlMs: 5000,
    interruptGraceMs: 3000
  });
  const owner = connectRpc(broker.endpoint);
  const { threadId } = await startActiveTurn(owner, broker.repo);
  await assert.rejects(
    owner.request("turn/start", {
      threadId,
      input: [{ type: "text", text: "same owner must not replace the active token", text_elements: [] }]
    }),
    /Shared Codex broker is busy/
  );
  owner.destroy();

  const fakeStatePath = path.join(broker.binDir, "fake-codex-state.json");
  await waitFor(() => {
    const state = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
    return state.lastInterrupt ?? null;
  });

  const contender = connectRpc(broker.endpoint);
  await contender.ready;
  await contender.request("initialize", { clientInfo: {}, capabilities: {} });
  await assert.rejects(
    contender.request("turn/start", {
      threadId,
      input: [{ type: "text", text: "must stay blocked before terminal", text_elements: [] }]
    }),
    /Shared Codex broker is busy/
  );

  await waitFor(async () => {
    try {
      await contender.request("thread/list", {});
      return true;
    } catch (error) {
      if (/Shared Codex broker is busy/.test(error.message)) {
        return false;
      }
      throw error;
    }
  }, 4000);
  assert.equal(processExists(broker.child.pid), true);
  contender.destroy();
});

for (const behavior of ["interrupt-ack-no-completion", "interrupt-fails-no-completion"]) {
  test(`${behavior} exits the broker after orphan grace`, async (t) => {
    const broker = await startBroker(t, { behavior, idleTtlMs: 5000, interruptGraceMs: 200 });
    const owner = connectRpc(broker.endpoint);
    await startActiveTurn(owner, broker.repo);
    owner.destroy();

    const fakeStatePath = path.join(broker.binDir, "fake-codex-state.json");
    await waitFor(() => {
      const state = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
      return state.lastInterrupt ?? null;
    });
    await waitFor(() => !processExists(broker.child.pid), 3000);
    assert.equal(fs.existsSync(broker.pidFile), false, broker.getStderr());
  });
}

test("compact stream without an interrupt target does not pin the broker", async (t) => {
  const broker = await startBroker(t, {
    behavior: "compact-never-completes",
    idleTtlMs: 5000,
    interruptGraceMs: 200
  });
  const client = connectRpc(broker.endpoint);
  await client.ready;
  await client.request("initialize", { clientInfo: {}, capabilities: {} });
  const startedThread = await client.request("thread/start", { cwd: broker.repo, ephemeral: true });
  await client.request("thread/compact/start", { threadId: startedThread.thread.id });

  client.destroy();

  await waitFor(() => !processExists(broker.child.pid), 3000);
  assert.equal(fs.existsSync(broker.pidFile), false, broker.getStderr());
});
