import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBrokerEndpoint, parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { terminateProcessTree } from "./process.mjs";
import { resolveStateDir } from "./state.mjs";
import { resolveCanonicalWorkspaceRoot } from "./workspace.mjs";

export const PID_FILE_ENV = "CODEX_COMPANION_APP_SERVER_PID_FILE";
export const LOG_FILE_ENV = "CODEX_COMPANION_APP_SERVER_LOG_FILE";
export const BROKER_IDLE_TTL_ENV = "CODEX_COMPANION_BROKER_IDLE_TTL_MS";
const BROKER_STATE_FILE = "broker.json";
const BROKER_LOCK_FILE = "broker.lock";
const BROKER_CONTROL_TIMEOUT_MS = 250;
const BROKER_RETRY_INTERVAL_MS = 50;
const DEFAULT_LOCK_WAIT_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_LOCK_RETRY_INTERVAL_MS = 50;

export function createBrokerSessionDir(prefix = "cxc-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function connectToEndpoint(endpoint) {
  const target = parseBrokerEndpoint(endpoint);
  return net.createConnection({ path: target.path });
}

function requestBrokerControl(endpoint, method, timeoutMs) {
  return new Promise((resolve) => {
    const requestId = 1;
    const socket = connectToEndpoint(endpoint);
    let buffer = "";
    let settled = false;

    const finish = (response = null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(response);
    };

    const timer = setTimeout(() => finish(), Math.max(1, timeoutMs));
    timer.unref?.();
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: requestId, method, params: {} })}\n`);
    });
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
        try {
          const response = JSON.parse(line);
          if (response.id === requestId) {
            finish(response);
            return;
          }
        } catch {
          finish();
          return;
        }
      }
    });
    socket.on("error", () => finish());
    socket.on("close", () => finish());
  });
}

export async function waitForBrokerEndpoint(endpoint, timeoutMs = 2000, expectedWorkspace = null, options = {}) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  const expectedWorkspaceRoot = expectedWorkspace ? resolveCanonicalWorkspaceRoot(expectedWorkspace) : null;
  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    const response = await requestBrokerControl(
      endpoint,
      "broker/health",
      Math.min(BROKER_CONTROL_TIMEOUT_MS, remainingMs)
    );
    const actualWorkspaceRoot = response?.result?.workspaceRoot ?? null;
    const workspaceMatches =
      !expectedWorkspaceRoot ||
      actualWorkspaceRoot === expectedWorkspaceRoot ||
      (options.allowMissingWorkspace === true && !actualWorkspaceRoot);
    if (response?.result?.status === "ok" && workspaceMatches) {
      return true;
    }
    const retryDelayMs = Math.min(BROKER_RETRY_INTERVAL_MS, deadline - Date.now());
    if (retryDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  return false;
}

export async function sendBrokerShutdown(endpoint, timeoutMs = 1000) {
  const response = await requestBrokerControl(endpoint, "broker/shutdown", timeoutMs);
  return Boolean(response?.result && !response.error);
}

export function spawnBrokerProcess({ scriptPath, cwd, endpoint, pidFile, logFile, env = process.env }) {
  const logFd = fs.openSync(logFile, "a");
  try {
    const child = spawn(process.execPath, [scriptPath, "serve", "--endpoint", endpoint, "--cwd", cwd, "--pid-file", pidFile], {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", logFd, logFd]
    });
    child.unref();
    return child;
  } finally {
    fs.closeSync(logFd);
  }
}

function resolveBrokerStateFile(cwd) {
  return path.join(resolveStateDir(cwd), BROKER_STATE_FILE);
}

function resolveBrokerLockFile(cwd) {
  return path.join(resolveStateDir(cwd), BROKER_LOCK_FILE);
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

function removeStaleBrokerLock(lockFile, staleTimeoutMs) {
  let rawOwner;
  let lockAgeMs;
  try {
    rawOwner = fs.readFileSync(lockFile, "utf8");
    lockAgeMs = Date.now() - fs.statSync(lockFile).mtimeMs;
  } catch (error) {
    return error?.code === "ENOENT";
  }

  let owner = null;
  try {
    owner = JSON.parse(rawOwner);
  } catch {
    // A newly-created lock may be observed before its owner record is flushed.
  }
  const hasValidOwner =
    Number.isInteger(owner?.pid) && owner.pid > 0 && typeof owner.token === "string" && owner.token.length > 0;
  const stale = hasValidOwner ? !isProcessAlive(owner.pid) : lockAgeMs >= staleTimeoutMs;
  if (!stale) {
    return false;
  }

  try {
    if (fs.readFileSync(lockFile, "utf8") !== rawOwner) {
      return false;
    }
    fs.unlinkSync(lockFile);
    return true;
  } catch (error) {
    return error?.code === "ENOENT";
  }
}

async function acquireBrokerLock(cwd, options = {}) {
  const stateDir = resolveStateDir(cwd);
  fs.mkdirSync(stateDir, { recursive: true });
  const lockFile = resolveBrokerLockFile(cwd);
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const waitTimeoutMs = options.lockWaitTimeoutMs ?? DEFAULT_LOCK_WAIT_TIMEOUT_MS;
  const staleTimeoutMs = options.staleLockTimeoutMs ?? DEFAULT_STALE_LOCK_TIMEOUT_MS;
  const retryIntervalMs = options.lockRetryIntervalMs ?? DEFAULT_LOCK_RETRY_INTERVAL_MS;
  const deadline = Date.now() + Math.max(0, waitTimeoutMs);

  while (true) {
    let fd = null;
    let createdLock = false;
    try {
      fd = fs.openSync(lockFile, "wx");
      createdLock = true;
      fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, token, createdAt: Date.now() })}\n`, "utf8");
      return { lockFile, token };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        if (createdLock) {
          if (fd !== null) {
            fs.closeSync(fd);
            fd = null;
          }
          try {
            fs.unlinkSync(lockFile);
          } catch {
            // The invalid lock will also be reclaimed by its timeout.
          }
        }
        throw error;
      }
    } finally {
      if (fd !== null) {
        fs.closeSync(fd);
      }
    }

    if (removeStaleBrokerLock(lockFile, staleTimeoutMs)) {
      continue;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(retryIntervalMs, remainingMs)));
  }
}

function releaseBrokerLock(lock) {
  if (!lock) {
    return;
  }
  try {
    const owner = JSON.parse(fs.readFileSync(lock.lockFile, "utf8"));
    if (owner.token === lock.token) {
      fs.unlinkSync(lock.lockFile);
    }
  } catch {
    // The lock may have been reclaimed after its timeout or removed with the state directory.
  }
}

function hasMatchingBrokerPidFile(session) {
  if (!Number.isInteger(session?.pid) || !session?.pidFile) {
    return false;
  }
  try {
    return Number(fs.readFileSync(session.pidFile, "utf8").trim()) === session.pid;
  } catch {
    return false;
  }
}

function unlinkIfPresent(filePath) {
  if (!filePath) {
    return;
  }
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

export function loadBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
}

export function saveBrokerSession(cwd, session) {
  const stateDir = resolveStateDir(cwd);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(resolveBrokerStateFile(cwd), `${JSON.stringify(session, null, 2)}\n`, "utf8");
}

export function clearBrokerSession(cwd) {
  unlinkIfPresent(resolveBrokerStateFile(cwd));
}

export async function markBrokerSessionStopped(cwd, endpoint, options = {}) {
  const lock = await acquireBrokerLock(cwd, options);
  if (!lock) {
    return;
  }
  try {
    const session = loadBrokerSession(cwd);
    if (session?.endpoint !== endpoint) {
      return;
    }
    saveBrokerSession(cwd, {
      ...session,
      pid: null,
      stoppedAt: new Date().toISOString()
    });
  } finally {
    releaseBrokerLock(lock);
  }
}

async function isBrokerEndpointReady(endpoint, cwd) {
  if (!endpoint) {
    return false;
  }
  try {
    return await waitForBrokerEndpoint(endpoint, 150, cwd, { allowMissingWorkspace: true });
  } catch {
    return false;
  }
}

export async function ensureBrokerSession(cwd, options = {}) {
  const existing = loadBrokerSession(cwd);
  if (existing && (await isBrokerEndpointReady(existing.endpoint, cwd))) {
    return existing;
  }

  const lock = await acquireBrokerLock(cwd, options);
  if (!lock) {
    const session = loadBrokerSession(cwd);
    return session && (await isBrokerEndpointReady(session.endpoint, cwd)) ? session : null;
  }

  try {
    const sessionAfterLock = loadBrokerSession(cwd);
    if (sessionAfterLock && (await isBrokerEndpointReady(sessionAfterLock.endpoint, cwd))) {
      return sessionAfterLock;
    }

    if (sessionAfterLock) {
      const killProcess =
        options.killProcess ?? (hasMatchingBrokerPidFile(sessionAfterLock) ? terminateProcessTree : null);
      teardownBrokerSession({
        endpoint: sessionAfterLock.endpoint ?? null,
        pidFile: sessionAfterLock.pidFile ?? null,
        logFile: sessionAfterLock.logFile ?? null,
        sessionDir: sessionAfterLock.sessionDir ?? null,
        pid: sessionAfterLock.pid ?? null,
        killProcess
      });
      clearBrokerSession(cwd);
    }

    const sessionDir = createBrokerSessionDir();
    const endpointFactory = options.createBrokerEndpoint ?? createBrokerEndpoint;
    const endpoint = endpointFactory(sessionDir, options.platform);
    const pidFile = path.join(sessionDir, "broker.pid");
    const logFile = path.join(sessionDir, "broker.log");
    const scriptPath =
      options.scriptPath ??
      fileURLToPath(new URL("../app-server-broker.mjs", import.meta.url));

    const child = spawnBrokerProcess({
      scriptPath,
      cwd,
      endpoint,
      pidFile,
      logFile,
      env: options.env ?? process.env
    });

    const ready = await waitForBrokerEndpoint(endpoint, options.timeoutMs ?? 2000, cwd);
    if (!ready) {
      teardownBrokerSession({
        endpoint,
        pidFile,
        logFile,
        sessionDir,
        pid: child.pid ?? null,
        killProcess: options.killProcess ?? terminateProcessTree
      });
      return null;
    }

    const session = {
      endpoint,
      pidFile,
      logFile,
      sessionDir,
      pid: child.pid ?? null
    };
    try {
      saveBrokerSession(cwd, session);
    } catch (error) {
      teardownBrokerSession({
        ...session,
        killProcess: options.killProcess ?? terminateProcessTree
      });
      throw error;
    }
    return session;
  } finally {
    releaseBrokerLock(lock);
  }
}

export function teardownBrokerSession({ endpoint = null, pidFile, logFile, sessionDir = null, pid = null, killProcess = null }) {
  if (Number.isFinite(pid) && killProcess) {
    try {
      killProcess(pid);
    } catch {
      // Ignore missing or already-exited broker processes.
    }
  }

  unlinkIfPresent(pidFile);
  unlinkIfPresent(logFile);

  if (endpoint) {
    try {
      const target = parseBrokerEndpoint(endpoint);
      if (target.kind === "unix" && fs.existsSync(target.path)) {
        fs.unlinkSync(target.path);
      }
    } catch {
      // Ignore malformed or already-removed broker endpoints during teardown.
    }
  }

  const resolvedSessionDir = sessionDir ?? (pidFile ? path.dirname(pidFile) : logFile ? path.dirname(logFile) : null);
  if (resolvedSessionDir && fs.existsSync(resolvedSessionDir)) {
    try {
      fs.rmdirSync(resolvedSessionDir);
    } catch {
      // Ignore non-empty or missing directories.
    }
  }
}
