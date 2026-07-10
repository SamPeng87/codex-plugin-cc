/**
 * @typedef {Error & { code?: string, data?: unknown, rpcCode?: number }} ProtocolError
 * @typedef {import("./app-server-protocol").AppServerMethod} AppServerMethod
 * @typedef {import("./app-server-protocol").AppServerNotification} AppServerNotification
 * @typedef {import("./app-server-protocol").AppServerNotificationHandler} AppServerNotificationHandler
 * @typedef {import("./app-server-protocol").ClientInfo} ClientInfo
 * @typedef {import("./app-server-protocol").CodexAppServerClientOptions} CodexAppServerClientOptions
 * @typedef {import("./app-server-protocol").InitializeCapabilities} InitializeCapabilities
 */
import fs from "node:fs";
import net from "node:net";
import process from "node:process";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { ensureBrokerSession, loadBrokerSession, waitForBrokerEndpoint } from "./broker-lifecycle.mjs";
import { terminateProcessTree } from "./process.mjs";

const PLUGIN_MANIFEST_URL = new URL("../../.claude-plugin/plugin.json", import.meta.url);
const PLUGIN_MANIFEST = JSON.parse(fs.readFileSync(PLUGIN_MANIFEST_URL, "utf8"));

export const BROKER_ENDPOINT_ENV = "CODEX_COMPANION_APP_SERVER_ENDPOINT";
export const BROKER_BUSY_RPC_CODE = -32001;

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;
const EXPLICIT_BROKER_PROBE_TIMEOUT_MS = 2_000;
const GRACEFUL_CLOSE_DELAY_MS = 50;
const RECOVERABLE_BROKER_CONNECTION_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOENT",
  "ETIMEDOUT",
  "EPIPE",
  "ERR_SOCKET_CLOSED"
]);

/** @type {ClientInfo} */
const DEFAULT_CLIENT_INFO = {
  title: "Codex Plugin",
  name: "Claude Code",
  version: PLUGIN_MANIFEST.version ?? "0.0.0"
};

/** @type {InitializeCapabilities} */
const DEFAULT_CAPABILITIES = {
  experimentalApi: false,
  requestAttestation: false,
  optOutNotificationMethods: [
    "item/agentMessage/delta",
    "item/reasoning/summaryTextDelta",
    "item/reasoning/summaryPartAdded",
    "item/reasoning/textDelta"
  ]
};

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function createProtocolError(message, data) {
  const error = /** @type {ProtocolError} */ (new Error(message));
  error.data = data;
  if (data?.code !== undefined) {
    error.rpcCode = data.code;
  }
  return error;
}

function resolvePositiveTimeout(value, fallback) {
  const timeoutMs = Number(value);
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : fallback;
}

function createTimeoutError(operation, timeoutMs) {
  const error = /** @type {ProtocolError} */ (new Error(`${operation} timed out after ${timeoutMs} ms.`));
  error.code = "ETIMEDOUT";
  return error;
}

function isRecoverableBrokerConnectionError(error) {
  return RECOVERABLE_BROKER_CONNECTION_CODES.has(error?.code);
}

async function waitForExit(exitPromise, timeoutMs) {
  let timer;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([exitPromise.then(() => true), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

class AppServerClientBase {
  constructor(cwd, options = {}) {
    this.cwd = cwd;
    this.options = options;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.closed = false;
    this.exitResolved = false;
    this.exitError = null;
    this.transportClosed = false;
    this.closePromise = null;
    this.requestTimeoutMs = resolvePositiveTimeout(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    this.closeTimeoutMs = resolvePositiveTimeout(options.closeTimeoutMs, DEFAULT_CLOSE_TIMEOUT_MS);
    /** @type {AppServerNotificationHandler | null} */
    this.notificationHandler = null;
    this.lineBuffer = "";
    this.transport = "unknown";

    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    this.transportClosePromise = new Promise((resolve) => {
      this.resolveTransportClose = resolve;
    });
  }

  setNotificationHandler(handler) {
    this.notificationHandler = handler;
  }

  /**
   * @template {AppServerMethod} M
   * @param {M} method
   * @param {import("./app-server-protocol").AppServerRequestParams<M>} params
   * @returns {Promise<import("./app-server-protocol").AppServerResponse<M>>}
   */
  request(method, params, options = {}) {
    if (this.closed) {
      throw this.exitError ?? new Error("codex app-server client is closed.");
    }

    const id = this.nextId;
    this.nextId += 1;
    const timeoutMs = resolvePositiveTimeout(options.timeoutMs, this.requestTimeoutMs);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) {
          return;
        }
        reject(createTimeoutError(`codex app-server RPC ${method}`, timeoutMs));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, method, timer });
      try {
        this.sendMessage({ id, method, params });
      } catch (error) {
        this.handleExit(error);
      }
    });
  }

  notify(method, params = {}) {
    if (this.closed) {
      return;
    }
    this.sendMessage({ method, params });
  }

  handleChunk(chunk) {
    this.lineBuffer += chunk;
    let newlineIndex = this.lineBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.lineBuffer.slice(0, newlineIndex);
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      this.handleLine(line);
      newlineIndex = this.lineBuffer.indexOf("\n");
    }
  }

  handleLine(line) {
    if (!line.trim()) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.handleExit(createProtocolError(`Failed to parse codex app-server JSONL: ${error.message}`, { line }));
      return;
    }

    if (message.id !== undefined && message.method) {
      this.handleServerRequest(message);
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(pending.timer);

      if (message.error) {
        pending.reject(createProtocolError(message.error.message ?? `codex app-server ${pending.method} failed.`, message.error));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (message.method && this.notificationHandler) {
      this.notificationHandler(/** @type {AppServerNotification} */ (message));
    }
  }

  handleServerRequest(message) {
    this.sendMessage({
      id: message.id,
      error: buildJsonRpcError(-32601, `Unsupported server request: ${message.method}`)
    });
  }

  handleExit(error) {
    if (this.exitResolved) {
      return;
    }

    this.exitResolved = true;
    this.closed = true;
    this.exitError = error ?? null;

    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.exitError ?? new Error("codex app-server connection closed."));
    }
    this.pending.clear();
    this.resolveExit(undefined);

    if (error) {
      try {
        this.abortTransport();
      } catch {
        // The protocol error remains authoritative; cleanup is best-effort.
      }
    }
  }

  markTransportClosed() {
    if (this.transportClosed) {
      return;
    }
    this.transportClosed = true;
    this.resolveTransportClose(undefined);
  }

  rejectPendingOnClose() {
    const error = new Error("codex app-server client is closed.");
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  sendMessage(_message) {
    throw new Error("sendMessage must be implemented by subclasses.");
  }

  abortTransport() {}
}

class SpawnedCodexAppServerClient extends AppServerClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "direct";
  }

  async initialize() {
    this.proc = spawn("codex", ["app-server"], {
      cwd: this.cwd,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32" ? (process.env.SHELL || true) : false,
      windowsHide: true
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");

    this.proc.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });

    this.proc.on("error", (error) => {
      this.handleExit(error);
    });

    this.proc.on("exit", (code, signal) => {
      const stderr = this.stderr.trim();
      const detail =
        code === 0
          ? null
          : createProtocolError(
              `codex app-server exited unexpectedly (${signal ? `signal ${signal}` : `exit ${code}`}).${stderr ? `\n${stderr}` : ""}`
            );
      this.handleExit(detail);
    });
    this.proc.on("close", () => {
      this.markTransportClosed();
    });

    this.readline = readline.createInterface({ input: this.proc.stdout });
    this.readline.on("line", (line) => {
      this.handleLine(line);
    });

    await this.request("initialize", {
      clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
      capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES
    });
    this.notify("initialized", {});
  }

  async close() {
    if (!this.closePromise) {
      this.closePromise = this.closeTransport();
    }
    await this.closePromise;
  }

  async closeTransport() {
    this.closed = true;
    this.rejectPendingOnClose();

    if (this.readline) {
      this.readline.close();
    }

    if (!this.proc) {
      this.markTransportClosed();
      this.handleExit(null);
      return;
    }

    if (this.proc.exitCode === null && this.proc.signalCode === null) {
      this.proc.stdin.end();
      setTimeout(() => {
        if (this.proc && this.proc.exitCode === null && this.proc.signalCode === null) {
          // On Windows with shell: true, the direct child is cmd.exe.
          // Use terminateProcessTree to kill the entire tree including
          // the grandchild node process.
          if (process.platform === "win32") {
            try {
              terminateProcessTree(this.proc.pid);
            } catch {
              // Best-effort cleanup inside an unref'd timer — swallow errors
              // to avoid crashing the host process during shutdown.
            }
          } else {
            this.proc.kill("SIGTERM");
          }
        }
      }, Math.min(GRACEFUL_CLOSE_DELAY_MS, this.closeTimeoutMs)).unref?.();
    }

    if (await waitForExit(this.transportClosePromise, this.closeTimeoutMs)) {
      return;
    }

    const error = createTimeoutError("codex app-server close", this.closeTimeoutMs);
    this.abortTransport();
    await waitForExit(this.transportClosePromise, Math.min(250, this.closeTimeoutMs));
    this.handleExit(error);
  }

  abortTransport() {
    if (this.readline) {
      this.readline.close();
    }
    this.proc?.stdin?.destroy();
    if (!this.proc || this.proc.exitCode !== null || this.proc.signalCode !== null) {
      return;
    }
    if (process.platform === "win32") {
      terminateProcessTree(this.proc.pid);
    } else {
      this.proc.kill("SIGKILL");
    }
  }

  sendMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    const stdin = this.proc?.stdin;
    if (!stdin) {
      throw new Error("codex app-server stdin is not available.");
    }
    stdin.write(line);
  }
}

class BrokerCodexAppServerClient extends AppServerClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "broker";
    this.endpoint = options.brokerEndpoint;
  }

  async initialize() {
    await new Promise((resolve, reject) => {
      const target = parseBrokerEndpoint(this.endpoint);
      this.socket = net.createConnection({ path: target.path });
      this.socket.setEncoding("utf8");
      const connectTimer = setTimeout(() => {
        const error = createTimeoutError("codex app-server broker connection", this.requestTimeoutMs);
        reject(error);
        this.socket.destroy();
        this.handleExit(error);
      }, this.requestTimeoutMs);
      this.socket.on("connect", () => {
        clearTimeout(connectTimer);
        resolve();
      });
      this.socket.on("data", (chunk) => {
        this.handleChunk(chunk);
      });
      this.socket.on("error", (error) => {
        clearTimeout(connectTimer);
        if (!this.exitResolved) {
          reject(error);
        }
        this.handleExit(error);
      });
      this.socket.on("close", () => {
        this.markTransportClosed();
        this.handleExit(this.exitError);
      });
    });

    await this.request("initialize", {
      clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
      capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES
    });
    this.notify("initialized", {});
  }

  async close() {
    if (!this.closePromise) {
      this.closePromise = this.closeTransport();
    }
    await this.closePromise;
  }

  async closeTransport() {
    this.closed = true;
    this.rejectPendingOnClose();
    if (!this.socket) {
      this.markTransportClosed();
      this.handleExit(null);
      return;
    }

    this.socket.end();
    if (await waitForExit(this.transportClosePromise, this.closeTimeoutMs)) {
      return;
    }
    this.abortTransport();
    await waitForExit(this.transportClosePromise, Math.min(250, this.closeTimeoutMs));
    this.handleExit(createTimeoutError("codex app-server broker close", this.closeTimeoutMs));
  }

  abortTransport() {
    this.socket?.destroy();
  }

  sendMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    const socket = this.socket;
    if (!socket) {
      throw new Error("codex app-server broker connection is not connected.");
    }
    socket.write(line);
  }
}

export class CodexAppServerClient {
  static async connect(cwd, options = {}) {
    let brokerEndpoint = null;
    let brokerEndpointSource = null;
    if (!options.disableBroker) {
      const explicitEndpoint = options.brokerEndpoint ?? null;
      if (explicitEndpoint) {
        if (!(await waitForBrokerEndpoint(explicitEndpoint, EXPLICIT_BROKER_PROBE_TIMEOUT_MS, cwd))) {
          throw new Error(`Configured Codex app-server broker is unavailable: ${explicitEndpoint}`);
        }
        brokerEndpoint = explicitEndpoint;
        brokerEndpointSource = "explicit";
      }
      if (!brokerEndpoint) {
        const existingEndpoint = loadBrokerSession(cwd)?.endpoint ?? null;
        if (
          existingEndpoint &&
          (await waitForBrokerEndpoint(existingEndpoint, 150, cwd, { allowMissingWorkspace: true }))
        ) {
          brokerEndpoint = existingEndpoint;
          brokerEndpointSource = "state";
        }
      }
      const envEndpoint = options.env?.[BROKER_ENDPOINT_ENV] ?? process.env[BROKER_ENDPOINT_ENV] ?? null;
      if (
        !brokerEndpoint &&
        envEndpoint &&
        envEndpoint !== explicitEndpoint &&
        (await waitForBrokerEndpoint(envEndpoint, 150, cwd))
      ) {
        brokerEndpoint = envEndpoint;
        brokerEndpointSource = "environment";
      }
      if (!brokerEndpoint && !options.reuseExistingBroker) {
        const brokerSession = await ensureBrokerSession(cwd, { env: options.env });
        brokerEndpoint = brokerSession?.endpoint ?? null;
        brokerEndpointSource = brokerEndpoint ? "ensured" : null;
      }
    }
    const client = brokerEndpoint
      ? new BrokerCodexAppServerClient(cwd, { ...options, brokerEndpoint })
      : new SpawnedCodexAppServerClient(cwd, options);
    try {
      await client.initialize();
      return client;
    } catch (error) {
      await client.close().catch(() => {});
      if (
        !brokerEndpoint ||
        brokerEndpointSource === "explicit" ||
        !isRecoverableBrokerConnectionError(error)
      ) {
        throw error;
      }

      // The broker may exit between its health check and the real client
      // connection. A direct app-server keeps that race from failing the job.
      const directClient = new SpawnedCodexAppServerClient(cwd, options);
      try {
        await directClient.initialize();
        return directClient;
      } catch (directError) {
        await directClient.close().catch(() => {});
        throw directError;
      }
    }
  }
}
