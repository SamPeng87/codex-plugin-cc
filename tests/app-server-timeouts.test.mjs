import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { once } from "node:events";

import { BROKER_ENDPOINT_ENV, CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import { loadBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { captureTurn, runAppServerTurn, TURN_TIMEOUT_ENV } from "../plugins/codex/scripts/lib/codex.mjs";
import { isProcessRunning } from "../plugins/codex/scripts/lib/process.mjs";
import { resolveCanonicalWorkspaceRoot } from "../plugins/codex/scripts/lib/workspace.mjs";
import { makeTempDir, writeExecutable } from "./helpers.mjs";

function directClientEnv(binDir) {
  return {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`
  };
}

function installHangingCodex(binDir, { initialize = true } = {}) {
  const scriptPath = path.join(binDir, "codex");
  writeExecutable(
    scriptPath,
    `#!/usr/bin/env node
const readline = require("node:readline");
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize" && ${JSON.stringify(initialize)}) {
    process.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: "hanging-test-server" } }) + "\\n");
  }
});
`
  );
}

function installCompletingCodexThatRefusesToExit(binDir) {
  const scriptPath = path.join(binDir, "codex");
  writeExecutable(
    scriptPath,
    `#!/usr/bin/env node
const readline = require("node:readline");
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "completion-close-test" } });
  } else if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thread-close-test" } } });
  } else if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-close-test", status: "inProgress" } } });
    send({ method: "item/completed", params: {
      threadId: "thread-close-test",
      turnId: "turn-close-test",
      item: { id: "message-close-test", type: "agentMessage", text: "Finished before close.", phase: "final_answer" }
    } });
    send({ method: "turn/completed", params: {
      threadId: "thread-close-test",
      turn: { id: "turn-close-test", status: "completed" }
    } });
  }
});
`
  );
}

function installMalformedCodex(binDir) {
  const scriptPath = path.join(binDir, "codex");
  writeExecutable(
    scriptPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
fs.writeFileSync(process.env.CODEX_TEST_PID_FILE, String(process.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", () => process.stdout.write("not-json\\n"));
`
  );
}

function installFallbackProbeCodex(binDir) {
  const scriptPath = path.join(binDir, "codex");
  writeExecutable(
    scriptPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method !== "initialize") return;
  fs.writeFileSync(process.env.CODEX_TEST_FALLBACK_MARKER, "started");
  process.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: "fallback-probe" } }) + "\\n");
  setTimeout(() => process.exit(0), 50);
});
`
  );
}

async function startBrokerThatStopsAfterHealth(cwd) {
  const socketPath = path.join(makeTempDir(), "broker.sock");
  const workspaceRoot = resolveCanonicalWorkspaceRoot(cwd);
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        return;
      }
      const message = JSON.parse(buffer.slice(0, newline));
      if (message.method !== "broker/health") {
        socket.destroy();
        return;
      }
      server.close();
      if (fs.existsSync(socketPath)) {
        fs.unlinkSync(socketPath);
      }
      socket.end(`${JSON.stringify({ id: message.id, result: { status: "ok", workspaceRoot } })}\n`, () => {
        socket.destroy();
      });
    });
    socket.on("close", () => sockets.delete(socket));
  });
  const closed = once(server, "close");
  server.listen(socketPath);
  await once(server, "listening");
  return {
    endpoint: `unix:${socketPath}`,
    async cleanup() {
      for (const socket of sockets) {
        socket.destroy();
      }
      if (server.listening) {
        server.close();
      }
      await closed;
      if (fs.existsSync(socketPath)) {
        fs.unlinkSync(socketPath);
      }
    }
  };
}

async function startBrokerIgnoringInitialize(cwd) {
  const socketPath = path.join(makeTempDir(), "broker.sock");
  const workspaceRoot = resolveCanonicalWorkspaceRoot(cwd);
  const sockets = new Set();
  let resolveInitialize;
  const initializeSeen = new Promise((resolve) => {
    resolveInitialize = resolve;
  });
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        const message = JSON.parse(line);
        if (message.method === "broker/health") {
          socket.write(`${JSON.stringify({ id: message.id, result: { status: "ok", workspaceRoot } })}\n`);
        } else if (message.method === "initialize") {
          resolveInitialize();
        }
      }
    });
    socket.on("close", () => sockets.delete(socket));
  });
  server.listen(socketPath);
  await once(server, "listening");
  return {
    endpoint: `unix:${socketPath}`,
    initializeSeen,
    async cleanup() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise((resolve) => server.close(resolve));
      if (fs.existsSync(socketPath)) {
        fs.unlinkSync(socketPath);
      }
    }
  };
}

class MockTurnClient {
  constructor() {
    this.closed = false;
    this.exitError = null;
    this.notificationHandler = null;
    this.requests = [];
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  setNotificationHandler(handler) {
    this.notificationHandler = handler;
  }

  request(method, params, options) {
    this.requests.push({ method, params, options });
    return Promise.resolve({});
  }

  emit(message) {
    this.notificationHandler?.(message);
  }

  disconnect(error = null) {
    this.closed = true;
    this.exitError = error;
    this.resolveExit();
  }
}

test("app-server RPC timeout rejects the request and clears it from pending", async () => {
  const binDir = makeTempDir();
  installHangingCodex(binDir);
  const client = await CodexAppServerClient.connect(binDir, {
    disableBroker: true,
    env: directClientEnv(binDir),
    requestTimeoutMs: 5000,
    closeTimeoutMs: 80
  });

  await assert.rejects(
    client.request("test/hang", {}, { timeoutMs: 20 }),
    (error) => error.code === "ETIMEDOUT" && /test\/hang/.test(error.message) && /20 ms/.test(error.message)
  );
  assert.equal(client.pending.size, 0);

  await client.close();
});

test("app-server exit rejects pending requests and prevents new requests", async () => {
  const binDir = makeTempDir();
  installHangingCodex(binDir);
  const client = await CodexAppServerClient.connect(binDir, {
    disableBroker: true,
    env: directClientEnv(binDir),
    requestTimeoutMs: 5000,
    closeTimeoutMs: 80
  });
  const pending = client.request("test/hang", {});

  client.proc.kill("SIGKILL");
  await assert.rejects(pending, /exited unexpectedly/);
  await client.exitPromise;
  assert.equal(client.closed, true);
  assert.throws(() => client.request("test/after-exit", {}), /exited unexpectedly/);
});

test("direct app-server close is bounded when the child ignores graceful shutdown", async () => {
  const binDir = makeTempDir();
  installHangingCodex(binDir);
  const client = await CodexAppServerClient.connect(binDir, {
    disableBroker: true,
    env: directClientEnv(binDir),
    requestTimeoutMs: 5000,
    closeTimeoutMs: 80
  });
  const proc = client.proc;
  const pending = client.request("test/hang", {});
  const pendingRejected = assert.rejects(pending, /client is closed/);
  const startedAt = Date.now();

  await client.close();
  await pendingRejected;

  assert.ok(Date.now() - startedAt < 1000);
  assert.equal(client.closed, true);
  if (proc.exitCode === null && proc.signalCode === null) {
    await Promise.race([once(proc, "exit"), new Promise((resolve) => setTimeout(resolve, 500))]);
  }
});

test("malformed direct app-server output should terminate the child transport", async () => {
  const binDir = makeTempDir();
  const pidFile = path.join(binDir, "codex.pid");
  installMalformedCodex(binDir);
  const env = {
    ...directClientEnv(binDir),
    CODEX_TEST_PID_FILE: pidFile
  };

  await assert.rejects(
    CodexAppServerClient.connect(binDir, {
      disableBroker: true,
      env,
      requestTimeoutMs: 5000,
      closeTimeoutMs: 200
    }),
    /Failed to parse codex app-server JSONL/
  );

  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  assert.equal(isProcessRunning(pid), false);
});

test("a completed turn is returned even when app-server refuses to exit", async () => {
  const binDir = makeTempDir();
  installCompletingCodexThatRefusesToExit(binDir);
  const startedAt = Date.now();
  let turnCompletedAt = null;

  const result = await runAppServerTurn(binDir, {
    prompt: "finish and then refuse shutdown",
    env: directClientEnv(binDir),
    disableBroker: true,
    requestTimeoutMs: 5000,
    closeTimeoutMs: 80,
    turnTimeoutMs: 1000,
    onProgress(event) {
      const message = typeof event === "string" ? event : event?.message;
      if (message === "Turn completed.") {
        turnCompletedAt = Date.now();
      }
    }
  });

  assert.equal(result.status, 0);
  assert.equal(result.finalMessage, "Finished before close.");
  assert.ok(Date.now() - startedAt < 4000);
  assert.ok(turnCompletedAt !== null);
  assert.ok(Date.now() - turnCompletedAt < 1000);
  assert.equal(loadBrokerSession(binDir), null);
});

test("broker app-server close is bounded when the peer never closes its half", { skip: process.platform === "win32" }, async () => {
  const socketPath = path.join(makeTempDir(), "broker.sock");
  const sockets = new Set();
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
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
          socket.write(`${JSON.stringify({
            id: message.id,
            result: { status: "ok", workspaceRoot: resolveCanonicalWorkspaceRoot(process.cwd()) }
          })}\n`);
        } else if (message.method === "initialize") {
          socket.write(`${JSON.stringify({ id: message.id, result: { userAgent: "test-broker" } })}\n`);
        }
      }
    });
    socket.on("close", () => sockets.delete(socket));
  });
  server.listen(socketPath);
  await once(server, "listening");

  let client = null;
  try {
    client = await CodexAppServerClient.connect(process.cwd(), {
      brokerEndpoint: `unix:${socketPath}`,
      requestTimeoutMs: 200,
      closeTimeoutMs: 30
    });
    const startedAt = Date.now();
    await client.close();

    assert.ok(Date.now() - startedAt < 1000);
    assert.equal(client.closed, true);
  } finally {
    await client?.close().catch(() => {});
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise((resolve) => server.close(resolve));
    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }
  }
});

test("malformed broker output should close the socket and fail an explicit endpoint", { skip: process.platform === "win32" }, async () => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  const fallbackMarker = path.join(binDir, "fallback-started");
  const socketPath = path.join(makeTempDir(), "broker.sock");
  const sockets = new Set();
  let initializeSocketClosed;
  const initializeSocketClose = new Promise((resolve) => {
    initializeSocketClosed = resolve;
  });
  installFallbackProbeCodex(binDir);

  const server = net.createServer((socket) => {
    sockets.add(socket);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        const message = JSON.parse(line);
        if (message.method === "broker/health") {
          socket.end(`${JSON.stringify({
            id: message.id,
            result: { status: "ok", workspaceRoot: resolveCanonicalWorkspaceRoot(workspace) }
          })}\n`);
        } else if (message.method === "initialize") {
          socket.write("not-json\n");
          socket.on("close", initializeSocketClosed);
        }
      }
    });
    socket.on("close", () => sockets.delete(socket));
  });
  server.listen(socketPath);
  await once(server, "listening");

  try {
    await assert.rejects(
      CodexAppServerClient.connect(workspace, {
        brokerEndpoint: `unix:${socketPath}`,
        env: {
          ...directClientEnv(binDir),
          CODEX_TEST_FALLBACK_MARKER: fallbackMarker
        },
        requestTimeoutMs: 500,
        closeTimeoutMs: 100
      }),
      /Failed to parse codex app-server JSONL/
    );
    await Promise.race([
      initializeSocketClose,
      new Promise((_, reject) => setTimeout(() => reject(new Error("broker socket remained open")), 500))
    ]);
    assert.equal(fs.existsSync(fallbackMarker), false);
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise((resolve) => server.close(resolve));
  }
});

test("implicit broker health-to-connect race should fall back to direct app-server", { skip: process.platform === "win32" }, async () => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  installHangingCodex(binDir);
  const broker = await startBrokerThatStopsAfterHealth(workspace);

  let client = null;
  try {
    client = await CodexAppServerClient.connect(workspace, {
      env: {
        ...directClientEnv(binDir),
        [BROKER_ENDPOINT_ENV]: broker.endpoint
      },
      requestTimeoutMs: 5000,
      closeTimeoutMs: 80
    });

    assert.equal(client.transport, "direct");
  } finally {
    await client?.close().catch(() => {});
    await broker.cleanup();
  }
});

test("implicit broker initialize timeout should fall back to direct app-server", { skip: process.platform === "win32" }, async () => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  installHangingCodex(binDir);
  const broker = await startBrokerIgnoringInitialize(workspace);

  let client = null;
  try {
    client = await CodexAppServerClient.connect(workspace, {
      env: {
        ...directClientEnv(binDir),
        [BROKER_ENDPOINT_ENV]: broker.endpoint
      },
      requestTimeoutMs: 5000,
      closeTimeoutMs: 80
    });

    await broker.initializeSeen;
    assert.equal(client.transport, "direct");
  } finally {
    await client?.close().catch(() => {});
    await broker.cleanup();
  }
});

test("explicit broker health-to-connect race should fail closed", { skip: process.platform === "win32" }, async () => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  const fallbackMarker = path.join(binDir, "fallback-started");
  installFallbackProbeCodex(binDir);
  const broker = await startBrokerThatStopsAfterHealth(workspace);

  try {
    await assert.rejects(
      CodexAppServerClient.connect(workspace, {
        brokerEndpoint: broker.endpoint,
        env: {
          ...directClientEnv(binDir),
          CODEX_TEST_FALLBACK_MARKER: fallbackMarker
        },
        requestTimeoutMs: 500,
        closeTimeoutMs: 80
      }),
      (error) => ["ECONNREFUSED", "ECONNRESET", "ENOENT", "ETIMEDOUT"].includes(error.code)
    );
    assert.equal(fs.existsSync(fallbackMarker), false);
  } finally {
    await broker.cleanup();
  }
});

test("captureTurn interrupts and reports thread and turn when its deadline expires", async () => {
  const client = new MockTurnClient();

  await assert.rejects(
    captureTurn(
      client,
      "thread-deadline",
      async () => ({ turn: { id: "turn-deadline", status: "inProgress" } }),
      { timeoutMs: 20, env: {} }
    ),
    (error) =>
      error.code === "ETIMEDOUT" &&
      error.threadId === "thread-deadline" &&
      error.turnId === "turn-deadline" &&
      /20 ms/.test(error.message)
  );

  assert.deepEqual(client.requests, [
    {
      method: "turn/interrupt",
      params: { threadId: "thread-deadline", turnId: "turn-deadline" },
      options: { timeoutMs: 5000 }
    }
  ]);
});

test("captureTurn reads its deadline from CODEX_COMPANION_TURN_TIMEOUT_MS", async () => {
  const client = new MockTurnClient();

  await assert.rejects(
    captureTurn(
      client,
      "thread-env-deadline",
      async () => ({ turn: { id: "turn-env-deadline", status: "inProgress" } }),
      { env: { [TURN_TIMEOUT_ENV]: "15" } }
    ),
    (error) => error.code === "ETIMEDOUT" && error.timeoutMs === 15
  );
  assert.equal(client.requests[0].method, "turn/interrupt");
});

test("captureTurn allows CODEX_COMPANION_TURN_TIMEOUT_MS=0 to disable the deadline", async () => {
  const client = new MockTurnClient();
  const capture = captureTurn(
    client,
    "thread-no-deadline",
    async () => ({ turn: { id: "turn-no-deadline", status: "inProgress" } }),
    { env: { [TURN_TIMEOUT_ENV]: "0" } }
  );
  setTimeout(() => {
    client.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-no-deadline",
        turn: { id: "turn-no-deadline", status: "completed" }
      }
    });
  }, 20);

  const state = await capture;
  assert.equal(state.finalTurn.status, "completed");
  assert.equal(client.requests.length, 0);
});

test("captureTurn rejects when the app-server connection exits", async () => {
  const client = new MockTurnClient();
  const capture = captureTurn(
    client,
    "thread-exit",
    async () => ({ turn: { id: "turn-exit", status: "inProgress" } }),
    { timeoutMs: 1000, env: {} }
  );
  setImmediate(() => client.disconnect(new Error("socket failed")));

  await assert.rejects(capture, /thread-exit, turn turn-exit: socket failed/);
});

test("captureTurn keeps the final-answer fallback when the connection exits before turn completion", async () => {
  const client = new MockTurnClient();
  const capture = captureTurn(
    client,
    "thread-final",
    async () => ({ turn: { id: "turn-final", status: "inProgress" } }),
    { timeoutMs: 1000, env: {} }
  );
  setImmediate(() => {
    client.emit({
      method: "item/completed",
      params: {
        threadId: "thread-final",
        turnId: "turn-final",
        item: { type: "agentMessage", id: "message-final", text: "Finished safely.", phase: "final_answer" }
      }
    });
    client.disconnect();
  });

  const state = await capture;
  assert.equal(state.lastAgentMessage, "Finished safely.");
  assert.equal(state.finalTurn.status, "completed");
});
