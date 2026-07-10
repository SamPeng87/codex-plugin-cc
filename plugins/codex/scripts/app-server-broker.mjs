#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { parseArgs } from "./lib/args.mjs";
import { BROKER_BUSY_RPC_CODE, CodexAppServerClient } from "./lib/app-server.mjs";
import { parseBrokerEndpoint } from "./lib/broker-endpoint.mjs";
import { BROKER_IDLE_TTL_ENV, markBrokerSessionStopped } from "./lib/broker-lifecycle.mjs";
import { terminateProcessTree } from "./lib/process.mjs";
import { resolveCanonicalWorkspaceRoot } from "./lib/workspace.mjs";

const STREAMING_METHODS = new Set(["turn/start", "review/start", "thread/compact/start"]);
const BROKER_INTERRUPT_GRACE_ENV = "CODEX_COMPANION_BROKER_INTERRUPT_GRACE_MS";
const DEFAULT_IDLE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_INTERRUPT_GRACE_MS = 5000;
const INTERRUPT_TIMEOUT_MS = 2000;
const APP_CLIENT_CLOSE_TIMEOUT_MS = 2000;
const SERVER_CLOSE_TIMEOUT_MS = 500;
const SOCKET_CLOSE_GRACE_MS = 50;

function buildStreamThreadIds(method, params, result) {
  const threadIds = new Set();
  if (params?.threadId) {
    threadIds.add(params.threadId);
  }
  if (method === "review/start" && result?.reviewThreadId) {
    threadIds.add(result.reviewThreadId);
  }
  return threadIds;
}

function buildStreamInterruptTargets(method, params, result) {
  const turnId = result?.turn?.id ?? null;
  const threadId = method === "review/start"
    ? result?.reviewThreadId ?? params?.threadId ?? null
    : params?.threadId ?? null;
  return threadId && turnId ? [{ threadId, turnId }] : [];
}

function parsePositiveDuration(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function settleWithin(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise).then(
        (value) => ({ completed: true, value }),
        (error) => ({ completed: true, error })
      ),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ completed: false }), timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function send(socket, message) {
  if (socket.destroyed) {
    return;
  }
  socket.write(`${JSON.stringify(message)}\n`);
}

function isInterruptRequest(message) {
  return message?.method === "turn/interrupt";
}

function writePidFile(pidFile) {
  if (!pidFile) {
    return;
  }
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, `${process.pid}\n`, "utf8");
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (subcommand !== "serve") {
    throw new Error("Usage: node scripts/app-server-broker.mjs serve --endpoint <value> [--cwd <path>] [--pid-file <path>]");
  }

  const { options } = parseArgs(argv, {
    valueOptions: ["cwd", "pid-file", "endpoint"]
  });

  if (!options.endpoint) {
    throw new Error("Missing required --endpoint.");
  }

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const workspaceRoot = resolveCanonicalWorkspaceRoot(cwd);
  const endpoint = String(options.endpoint);
  const listenTarget = parseBrokerEndpoint(endpoint);
  const pidFile = options["pid-file"] ? path.resolve(options["pid-file"]) : null;
  const idleTtlMs = parsePositiveDuration(process.env[BROKER_IDLE_TTL_ENV], DEFAULT_IDLE_TTL_MS);
  const interruptGraceMs = parsePositiveDuration(
    process.env[BROKER_INTERRUPT_GRACE_ENV],
    DEFAULT_INTERRUPT_GRACE_MS
  );
  writePidFile(pidFile);

  const appClient = await CodexAppServerClient.connect(cwd, { disableBroker: true });
  let activeRequestSocket = null;
  let activeStreamSocket = null;
  let activeStreamThreadIds = null;
  let activeStreamInterruptTargets = null;
  let activeStreamToken = null;
  let abandonedStreamTimer = null;
  let idleTimer = null;
  let shutdownPromise = null;
  const sockets = new Set();

  function clearActiveStream() {
    if (abandonedStreamTimer) {
      clearTimeout(abandonedStreamTimer);
      abandonedStreamTimer = null;
    }
    activeStreamSocket = null;
    activeStreamThreadIds = null;
    activeStreamInterruptTargets = null;
    activeStreamToken = null;
  }

  function streamMatchesThread(threadId) {
    return !threadId || !activeStreamThreadIds || activeStreamThreadIds.size === 0 || activeStreamThreadIds.has(threadId);
  }

  function clearIdleTimer() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function scheduleAbandonedStreamShutdown(server, streamToken) {
    if (abandonedStreamTimer || !streamToken || activeStreamToken !== streamToken || shutdownPromise) {
      return;
    }
    abandonedStreamTimer = setTimeout(() => {
      abandonedStreamTimer = null;
      if (activeStreamToken === streamToken && !shutdownPromise) {
        void shutdownAndExit(server);
      }
    }, interruptGraceMs);
    abandonedStreamTimer.unref?.();
  }

  function scheduleIdleShutdown(server) {
    clearIdleTimer();
    if (shutdownPromise || sockets.size > 0 || activeStreamToken) {
      return;
    }
    idleTimer = setTimeout(async () => {
      idleTimer = null;
      if (sockets.size > 0 || activeStreamToken || shutdownPromise) {
        return;
      }
      await shutdownAndExit(server);
    }, idleTtlMs);
    idleTimer.unref?.();
  }

  function clearRequestOwnership(socket) {
    if (activeRequestSocket === socket) {
      activeRequestSocket = null;
    }
  }

  function routeNotification(message) {
    const target = activeRequestSocket ?? activeStreamSocket;
    if (target) {
      send(target, message);
    }
    if ((message.method === "turn/completed" || message.method === "thread/compacted") && activeStreamToken) {
      const threadId = message.params?.threadId ?? null;
      if (streamMatchesThread(threadId)) {
        clearActiveStream();
        if (activeRequestSocket === target) {
          activeRequestSocket = null;
        }
        scheduleIdleShutdown(server);
      }
    }
  }

  async function interruptAbandonedStream(targets) {
    if (!targets || targets.length === 0 || shutdownPromise) {
      return;
    }
    await Promise.all(
      targets.map(({ threadId, turnId }) =>
        settleWithin(appClient.request("turn/interrupt", { threadId, turnId }), INTERRUPT_TIMEOUT_MS)
      )
    );
  }

  async function releaseSocket(socket, server) {
    sockets.delete(socket);
    clearRequestOwnership(socket);
    if (activeStreamSocket === socket) {
      const streamToken = activeStreamToken;
      const targets = activeStreamInterruptTargets;
      activeStreamSocket = null;
      scheduleAbandonedStreamShutdown(server, streamToken);
      if (targets?.length > 0) {
        await interruptAbandonedStream(targets);
      }
    }
    scheduleIdleShutdown(server);
  }

  async function shutdown(server) {
    if (shutdownPromise) {
      return shutdownPromise;
    }
    clearIdleTimer();
    if (abandonedStreamTimer) {
      clearTimeout(abandonedStreamTimer);
      abandonedStreamTimer = null;
    }
    shutdownPromise = (async () => {
      const serverClose = new Promise((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
      });

      for (const socket of sockets) {
        socket.end();
      }
      const forceSocketClose = setTimeout(() => {
        for (const socket of sockets) {
          socket.destroy();
        }
      }, SOCKET_CLOSE_GRACE_MS);
      forceSocketClose.unref?.();

      const appCloseResult = await settleWithin(appClient.close(), APP_CLIENT_CLOSE_TIMEOUT_MS);
      if (!appCloseResult.completed && Number.isFinite(appClient.proc?.pid)) {
        try {
          terminateProcessTree(appClient.proc.pid);
        } catch {
          // The broker is exiting regardless; the child may already be gone.
        }
      }
      await settleWithin(serverClose, SERVER_CLOSE_TIMEOUT_MS);
      clearTimeout(forceSocketClose);
      for (const socket of sockets) {
        socket.destroy();
      }

      if (listenTarget.kind === "unix" && fs.existsSync(listenTarget.path)) {
        try {
          fs.unlinkSync(listenTarget.path);
        } catch {
          // Another cleanup path may already have removed the endpoint.
        }
      }
      if (pidFile && fs.existsSync(pidFile)) {
        try {
          fs.unlinkSync(pidFile);
        } catch {
          // The state file is marked stopped below even if this best-effort cleanup loses a race.
        }
      }
      await markBrokerSessionStopped(cwd, endpoint, { lockWaitTimeoutMs: 250 }).catch(() => {});
    })();
    return shutdownPromise;
  }

  async function shutdownAndExit(server, exitCode = 0) {
    try {
      await shutdown(server);
    } finally {
      process.exit(exitCode);
    }
  }

  appClient.setNotificationHandler(routeNotification);

  const server = net.createServer((socket) => {
    clearIdleTimer();
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";

    socket.on("data", async (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");

        if (!line.trim()) {
          continue;
        }

        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          send(socket, {
            id: null,
            error: buildJsonRpcError(-32700, `Invalid JSON: ${error.message}`)
          });
          continue;
        }

        if (message.id !== undefined && message.method === "initialize") {
          send(socket, {
            id: message.id,
            result: {
              userAgent: "codex-companion-broker"
            }
          });
          continue;
        }

        if (message.method === "initialized" && message.id === undefined) {
          continue;
        }

        if (message.id !== undefined && message.method === "broker/health") {
          send(socket, { id: message.id, result: { status: "ok", workspaceRoot } });
          continue;
        }

        if (message.id !== undefined && message.method === "broker/shutdown") {
          send(socket, { id: message.id, result: {} });
          await shutdownAndExit(server);
        }

        if (message.id === undefined) {
          continue;
        }

        const allowInterruptDuringActiveStream =
          isInterruptRequest(message) && activeStreamToken && activeStreamSocket !== socket && !activeRequestSocket;
        const startsAnotherStream = activeStreamToken && STREAMING_METHODS.has(message.method);
        const streamOwnedByAnotherSocket = activeStreamToken && activeStreamSocket !== socket;

        if (
          ((activeRequestSocket && activeRequestSocket !== socket) || streamOwnedByAnotherSocket || startsAnotherStream) &&
          !allowInterruptDuringActiveStream
        ) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "Shared Codex broker is busy.")
          });
          continue;
        }

        if (allowInterruptDuringActiveStream) {
          try {
            const result = await appClient.request(message.method, message.params ?? {});
            send(socket, { id: message.id, result });
          } catch (error) {
            send(socket, {
              id: message.id,
              error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
            });
          }
          continue;
        }

        const isStreaming = STREAMING_METHODS.has(message.method);
        const streamToken = isStreaming ? {} : null;
        if (streamToken) {
          if (abandonedStreamTimer) {
            clearTimeout(abandonedStreamTimer);
            abandonedStreamTimer = null;
          }
          activeStreamToken = streamToken;
          activeStreamSocket = socket;
          activeStreamThreadIds = message.method === "review/start"
            ? new Set()
            : buildStreamThreadIds(message.method, message.params ?? {}, null);
          activeStreamInterruptTargets = [];
        }
        activeRequestSocket = socket;

        try {
          const result = await appClient.request(message.method, message.params ?? {});
          send(socket, { id: message.id, result });
          if (streamToken && activeStreamToken === streamToken) {
            activeStreamThreadIds = buildStreamThreadIds(message.method, message.params ?? {}, result);
            activeStreamInterruptTargets = buildStreamInterruptTargets(message.method, message.params ?? {}, result);
            if (sockets.has(socket) && !socket.destroyed) {
              activeStreamSocket = socket;
            } else {
              activeStreamSocket = null;
              const targets = activeStreamInterruptTargets;
              scheduleAbandonedStreamShutdown(server, streamToken);
              await interruptAbandonedStream(targets);
            }
          }
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
          scheduleIdleShutdown(server);
        } catch (error) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
          });
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
          if (streamToken && activeStreamToken === streamToken) {
            clearActiveStream();
          }
          scheduleIdleShutdown(server);
        }
      }
    });

    socket.on("close", () => {
      void releaseSocket(socket, server);
    });

    socket.on("error", () => {
      void releaseSocket(socket, server);
    });
  });

  process.once("SIGTERM", () => {
    void shutdownAndExit(server);
  });

  process.once("SIGINT", () => {
    void shutdownAndExit(server);
  });

  server.listen(listenTarget.path, () => {
    scheduleIdleShutdown(server);
  });
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
