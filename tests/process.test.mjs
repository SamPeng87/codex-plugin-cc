import test from "node:test";
import assert from "node:assert/strict";

import { isProcessRunning, terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";

test("isProcessRunning probes a positive PID without sending a signal", () => {
  const calls = [];
  const running = isProcessRunning(1234, {
    killImpl(pid, signal) {
      calls.push([pid, signal]);
    }
  });

  assert.equal(running, true);
  assert.deepEqual(calls, [[1234, 0]]);
});

test("isProcessRunning distinguishes a missing process from an inaccessible live process", () => {
  assert.equal(
    isProcessRunning(1234, {
      killImpl() {
        throw Object.assign(new Error("missing"), { code: "ESRCH" });
      }
    }),
    false
  );
  assert.equal(
    isProcessRunning(1234, {
      killImpl() {
        throw Object.assign(new Error("not permitted"), { code: "EPERM" });
      }
    }),
    true
  );
});

test("terminateProcessTree falls back to the positive PID when the process group is missing", () => {
  const calls = [];
  const outcome = terminateProcessTree(1234, {
    platform: "darwin",
    killImpl(pid, signal) {
      calls.push([pid, signal]);
      if (pid < 0) {
        throw Object.assign(new Error("missing group"), { code: "ESRCH" });
      }
    }
  });

  assert.deepEqual(calls, [
    [-1234, "SIGTERM"],
    [1234, "SIGTERM"]
  ]);
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "process");
});

test("terminateProcessTree reports an undelivered signal only after both PID forms are missing", () => {
  const calls = [];
  const outcome = terminateProcessTree(1234, {
    platform: "linux",
    killImpl(pid, signal) {
      calls.push([pid, signal]);
      throw Object.assign(new Error("missing"), { code: "ESRCH" });
    }
  });

  assert.deepEqual(calls, [
    [-1234, "SIGTERM"],
    [1234, "SIGTERM"]
  ]);
  assert.equal(outcome.attempted, true);
  assert.equal(outcome.delivered, false);
  assert.equal(outcome.method, "process");
});

test("terminateProcessTree uses taskkill on Windows", () => {
  let captured = null;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      captured = { command, args };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
        error: null
      };
    },
    killImpl() {
      throw new Error("kill fallback should not run");
    }
  });

  assert.deepEqual(captured, {
    command: "taskkill",
    args: ["/PID", "1234", "/T", "/F"]
  });
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "taskkill");
});

test("terminateProcessTree treats missing Windows processes as already stopped", () => {
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: "ERROR: The process \"1234\" not found.",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.delivered, false);
  assert.equal(outcome.method, "taskkill");
  assert.equal(outcome.result.status, 128);
  assert.match(outcome.result.stdout, /not found/i);
});
