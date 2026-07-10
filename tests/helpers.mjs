import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { after } from "node:test";

import {
  clearBrokerSession,
  loadBrokerSession,
  sendBrokerShutdown,
  teardownBrokerSession
} from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";

const brokerWorkspaces = new Set();

function tracksBrokerProcess(command, args) {
  if (command !== "node" && command !== process.execPath) {
    return false;
  }
  return args.some((argument) =>
    /(?:codex-companion|stop-review-gate-hook|session-lifecycle-hook)\.mjs$/.test(String(argument))
  );
}

function resolveBrokerWorkspace(args, fallbackCwd) {
  const cwdIndex = args.indexOf("--cwd");
  const inlineCwd = args.find((argument) => String(argument).startsWith("--cwd="));
  const requestedCwd = cwdIndex === -1 ? inlineCwd?.slice("--cwd=".length) : args[cwdIndex + 1];
  return requestedCwd ? path.resolve(fallbackCwd, requestedCwd) : fallbackCwd;
}

async function cleanupTrackedBrokers() {
  for (const cwd of brokerWorkspaces) {
    const session = loadBrokerSession(cwd);
    if (!session) {
      continue;
    }
    if (session.endpoint) {
      await sendBrokerShutdown(session.endpoint, 300).catch(() => false);
    }
    teardownBrokerSession({
      endpoint: session.endpoint ?? null,
      pidFile: session.pidFile ?? null,
      logFile: session.logFile ?? null,
      sessionDir: session.sessionDir ?? null,
      pid: session.pid ?? null,
      killProcess: terminateProcessTree
    });
    clearBrokerSession(cwd);
  }
  brokerWorkspaces.clear();
}

after(cleanupTrackedBrokers);

export function makeTempDir(prefix = "codex-plugin-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o755 });
}

export function run(command, args, options = {}) {
  if (options.cwd && tracksBrokerProcess(command, args)) {
    brokerWorkspaces.add(resolveBrokerWorkspace(args, options.cwd));
  }
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    shell: process.platform === "win32" && !path.isAbsolute(command),
    windowsHide: true
  });
}

export function initGitRepo(cwd) {
  run("git", ["init", "-b", "main"], { cwd });
  run("git", ["config", "user.name", "Codex Plugin Tests"], { cwd });
  run("git", ["config", "user.email", "tests@example.com"], { cwd });
  run("git", ["config", "commit.gpgsign", "false"], { cwd });
  run("git", ["config", "tag.gpgsign", "false"], { cwd });
}
