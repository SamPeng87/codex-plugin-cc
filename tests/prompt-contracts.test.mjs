import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readPrompt(name) {
  return fs.readFileSync(path.join(ROOT, "plugins", "codex", "prompts", `${name}.md`), "utf8");
}

function assertOrdered(source, values) {
  let previous = -1;
  for (const value of values) {
    const index = source.indexOf(value);
    assert.ok(index > previous, `expected ordered prompt clause: ${value}`);
    previous = index;
  }
}

test("design review protects implementation freedom while enforcing boundary evidence", () => {
  const source = readPrompt("design-review");

  assert.match(source, /implementation_freedom_and_materiality_gate/);
  assert.match(source, /multiple internal implementations.*equivalent for plan review/is);
  assert.match(source, /Before emitting a finding, identify that counterfactual outcome/i);
  assert.match(source, /Acceptance outcome clarity/);
  assert.doesNotMatch(source, /Acceptance criteria automatability/);
  assert.match(source, /exact third-party interface\/class\/method/i);
  assert.match(source, /single semantic owner/i);
  assert.match(source, /hypothetical future callers/i);
});

test("adversarial review rejects unreachable findings and requires semantic duplicate evidence", () => {
  const source = readPrompt("adversarial-review");

  assert.match(source, /production entrypoint -> concrete trigger and data\/state source -> actual call chain or framework wiring -> defect sink -> observable consequence/);
  assert.match(source, /If it remains unproven, discard the finding/i);
  assert.match(source, /Do not downgrade an unproven path/i);
  assert.match(source, /at least two concrete file\/symbol locations/i);
  assert.match(source, /hypothetical future reuse/i);
});

test("execute uses bounded dependency research and one semantic owner", () => {
  const source = readPrompt("execute");

  assertOrdered(source, [
    "existing production usages and analogous implementations in this repository",
    "the approved plan's recorded API use and evidence",
    "current official documentation or API reference for the dependency version",
    "local source or type declarations",
    "only for a private undocumented dependency, targeted inspection of the exact artifact, class, and method"
  ]);
  assert.match(source, /Network access is limited to read-only lookups of current official documentation/i);
  assert.match(source, /Never bulk unpack or decompile JAR\/AAR files, dependency caches, or unrelated packages/i);
  assert.match(source, /one implementation owner for each semantic operation/i);
  assert.match(source, /hypothetical future callers are not justification/i);
});
