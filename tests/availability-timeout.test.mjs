import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";

import { getCodexAvailability } from "../plugins/codex/scripts/lib/codex.mjs";
import { makeTempDir, writeExecutable } from "./helpers.mjs";

function installAvailabilityProbe(binDir, hangingProbe) {
  const scriptPath = path.join(binDir, "codex");
  writeExecutable(
    scriptPath,
    `#!/usr/bin/env node
const probe = process.argv.slice(2).join(" ");
if (probe === ${JSON.stringify(hangingProbe)}) {
  setInterval(() => {}, 1000);
} else if (probe === "--version") {
  console.log("codex-cli 0.0.0-test");
} else if (probe === "app-server --help") {
  console.log("Usage: codex app-server");
} else {
  process.exitCode = 2;
}
`
  );

  if (process.platform === "win32") {
    fs.writeFileSync(path.join(binDir, "codex.cmd"), `@echo off\r\nnode "%~dp0codex" %*\r\n`, "utf8");
  }
}

function probeEnv(binDir) {
  const separator = process.platform === "win32" ? ";" : ":";
  return {
    ...process.env,
    PATH: `${binDir}${separator}${process.env.PATH}`
  };
}

function assertProbeTimesOut(hangingProbe, expectedDetail) {
  const cwd = makeTempDir();
  const binDir = makeTempDir();
  const timeoutMs = 3_000;
  installAvailabilityProbe(binDir, hangingProbe);

  const startedAt = Date.now();
  const availability = getCodexAvailability(cwd, {
    env: probeEnv(binDir),
    timeoutMs
  });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(availability.available, false);
  assert.match(availability.detail, expectedDetail);
  assert.match(availability.detail, /timed out after 3000 ms/);
  assert.ok(elapsedMs < 8_000, `availability probe took ${elapsedMs} ms`);
}

test("Codex availability stops waiting when codex --version never exits", () => {
  assertProbeTimesOut("--version", /^timed out after 3000 ms$/);
});

test("Codex availability stops waiting when codex app-server --help never exits", () => {
  assertProbeTimesOut("app-server --help", /codex-cli 0\.0\.0-test; advanced runtime unavailable:/);
});
