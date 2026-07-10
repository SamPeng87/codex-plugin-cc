#!/usr/bin/env node

import fs from "node:fs";

import {
  setConfig,
  updateJobRecord,
  upsertJob,
  writeJobFile
} from "../plugins/codex/scripts/lib/state.mjs";

const sleepBuffer = new SharedArrayBuffer(4);

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(sleepBuffer), 0, 0, milliseconds);
}

function waitForFile(filePath) {
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for fixture signal: ${filePath}`);
    }
    sleep(5);
  }
}

const [mode, workspace, signalFile, identity, rawCountOrStatus, rawDelay] = process.argv.slice(2);

if (mode === "upsert") {
  fs.writeFileSync(`${signalFile}.${identity}.ready`, "ready\n", "utf8");
  waitForFile(signalFile);
  const count = Number(rawCountOrStatus);
  for (let index = 0; index < count; index += 1) {
    upsertJob(workspace, {
      id: `${identity}-${index}`,
      status: "running",
      source: identity
    });
    sleep(index % 3);
  }
} else if (mode === "transition") {
  fs.writeFileSync(`${signalFile}.${identity}.ready`, "ready\n", "utf8");
  waitForFile(signalFile);
  updateJobRecord(workspace, "transition-job", (current) => {
    sleep(Number(rawDelay));
    return {
      ...current,
      status: rawCountOrStatus,
      source: identity
    };
  });
} else if (mode === "atomic-writer") {
  const count = Number(rawCountOrStatus);
  const payloadSize = Number(rawDelay);
  for (let generation = 1; generation <= count; generation += 1) {
    const character = generation % 2 === 0 ? "a" : "b";
    const payload = character.repeat(payloadSize);
    writeJobFile(workspace, "atomic-job", {
      id: "atomic-job",
      generation,
      payload,
      status: "running"
    });
    setConfig(workspace, "atomicPayload", { generation, payload });
  }
  fs.writeFileSync(signalFile, "done\n", "utf8");
} else if (mode === "set-config") {
  setConfig(workspace, identity, rawCountOrStatus);
} else {
  throw new Error(`Unknown state fixture mode: ${mode}`);
}
