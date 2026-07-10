import process from "node:process";

import { ensureBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";

const [cwd, rawTimeoutMs] = process.argv.slice(2);
const timeoutMs = Number(rawTimeoutMs);
const session = await ensureBrokerSession(cwd, {
  env: process.env,
  timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 5000
});

process.stdout.write(`${JSON.stringify(session)}\n`);
