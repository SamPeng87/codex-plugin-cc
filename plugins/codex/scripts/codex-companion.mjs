#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
    buildPersistentTaskThreadName,
    DEFAULT_CONTINUE_PROMPT,
    findLatestTaskThread,
    getCodexAuthStatus,
    getCodexAvailability,
    getSessionRuntimeStatus,
    importExternalAgentSession,
    interruptAppServerTurn,
    parseStructuredOutput,
    readOutputSchema,
    runAppServerReview,
    runAppServerTurn
  } from "./lib/codex.mjs";
import { resolveClaudeSessionPath } from "./lib/claude-session-transfer.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { addLineNumbers, collectVaultDocumentContext, discoverVaultDocPaths, resolveVaultTaskFolder } from "./lib/vault.mjs";
import { binaryAvailable, terminateProcessTree } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  generateJobId,
  getConfig,
  listJobs,
  setConfig,
  updateJobRecord
} from "./lib/state.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  reconcileActiveJobs,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  renderNativeReviewResult,
  renderReviewResult,
  renderStoredJobResult,
  renderCancelReport,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport,
  renderTaskResult,
  renderTestPlanReviewResult,
  renderDesignReviewResult
} from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const TEST_PLAN_REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "test-plan-review-output.schema.json");
const DESIGN_REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "design-review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const DEFAULT_AWAIT_RESULT_TIMEOUT_MS = 2760000;
const VALID_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const MODEL_ALIASES = new Map([["spark", "gpt-5.3-codex-spark"]]);
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/codex-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--json]",
      "  node scripts/codex-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>]",
      "  node scripts/codex-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model>] [--effort <none|minimal|low|medium|high|xhigh|max>] [focus text]",
      "  node scripts/codex-companion.mjs design-review [--wait|--background] [--path <vault-folder>|--task <task-id>] [--model <model>] [--effort <none|minimal|low|medium|high|xhigh|max>] [focus text]",
      "  node scripts/codex-companion.mjs test-plan-review [--wait|--background] [--path <vault-folder>|--task <task-id>] [--model <model>] [--effort <none|minimal|low|medium|high|xhigh|max>] [focus text]",
      "  node scripts/codex-companion.mjs execute --context-file <path> [--phase implement|write-tests|fix-tests] [--model <model>] [--effort <none|minimal|low|medium|high|xhigh|max>] [--write] [--background|--wait]",
      "  node scripts/codex-companion.mjs execute-test --context-file <path> [--model <model>] [--effort <none|minimal|low|medium|high|xhigh|max>] [--write] [--background|--wait]",
      "  node scripts/codex-companion.mjs execute-fix --context-file <path> [--model <model>] [--effort <none|minimal|low|medium|high|xhigh|max>] [--write] [--background|--wait]",
      "  node scripts/codex-companion.mjs task [--background|--wait] [--write] [--resume-last|--resume|--fresh] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh|max>] [prompt]",
      "  node scripts/codex-companion.mjs transfer [--source <claude-jsonl>] [--json]",
      "  node scripts/codex-companion.mjs status [job-id] [--all] [--json]",
      "  node scripts/codex-companion.mjs await-result <job-id> [--timeout-ms <ms>] [--json|--jsonl|--monitor]",
      "  node scripts/codex-companion.mjs result [job-id] [--json]",
      "  node scripts/codex-companion.mjs cancel [job-id] [--json]"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeRequestedModel(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return null;
  }
  return MODEL_ALIASES.get(normalized.toLowerCase()) ?? normalized;
}

function normalizeReasoningEffort(effort) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_REASONING_EFFORTS.has(normalized)) {
    throw new Error(
      `Unsupported reasoning effort "${effort}". Use one of: none, minimal, low, medium, high, xhigh, max.`
    );
  }
  return normalized;
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function validateExecutionMode(options) {
  if (options.background && options.wait) {
    throw new Error("Choose either --background or --wait.");
  }
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

async function buildSetupReport(cwd, actionsTaken = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const codexStatus = getCodexAvailability(cwd);
  const authStatus = await getCodexAuthStatus(cwd);
  const config = getConfig(workspaceRoot);

  const nextSteps = [];
  if (!codexStatus.available) {
    nextSteps.push("Install Codex with `npm install -g @openai/codex`.");
  }
  if (codexStatus.available && !authStatus.loggedIn && authStatus.requiresOpenaiAuth) {
    nextSteps.push("Run `!codex login`.");
    nextSteps.push("If browser login is blocked, retry with `!codex login --device-auth` or `!codex login --with-api-key`.");
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: run `/codex:setup --enable-review-gate` to require a fresh review before stop.");
  }

  return {
    ready: nodeStatus.available && codexStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    npm: npmStatus,
    codex: codexStatus,
    auth: authStatus,
    sessionRuntime: getSessionRuntimeStatus(process.env, workspaceRoot),
    reviewGateEnabled: Boolean(config.stopReviewGate),
    actionsTaken,
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken);
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

function buildAdversarialReviewPrompt(context, focusText) {
  const template = loadPromptTemplate(ROOT_DIR, "adversarial-review");
  return interpolateTemplate(template, {
    REVIEW_KIND: "Adversarial Review",
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  });
}

function buildDesignReviewPrompt(context, focusText) {
  const template = loadPromptTemplate(ROOT_DIR, "design-review");
  return interpolateTemplate(template, {
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    PLAN_CONTENT: addLineNumbers(context.planContent || ""),
    DESIGN_CONTEXT: context.relatedContent || "",
    PROJECT_CONTEXT: context.projectContext || ""
  });
}

function buildTestPlanReviewPrompt(context, focusText) {
  const template = loadPromptTemplate(ROOT_DIR, "test-plan-review");
  return interpolateTemplate(template, {
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    TEST_PLAN_CONTENT: context.testPlanContent,
    DESIGN_CONTEXT: context.designContext || "(no plan.md found)",
    PLAN_CONTENT: context.designContext || "(no plan.md found)",
    PROJECT_CONTEXT: context.projectContext || ""
  });
}

function readContextFile(cwd, contextFilePath) {
  const resolved = path.resolve(cwd, contextFilePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Context file not found: ${resolved}`);
  }
  return JSON.parse(fs.readFileSync(resolved, "utf8"));
}

function buildExecutePrompt(context) {
  const template = loadPromptTemplate(ROOT_DIR, "execute");

  const trackerMetadata = context.mode === "1" && context.tracker
    ? `Priority/Status/Assignee: ${context.tracker.priority || "n/a"}/${context.tracker.status || "n/a"}/${context.tracker.assignee || "n/a"}\n`
    : "";

  let description;
  if (context.mode === "3") {
    description = context.description || context.summary || "";
  } else if (context.mode === "1" && context.tracker?.description) {
    description = context.tracker.description;
  } else {
    description = "详见设计稿和执行计划稿";
  }

  const trackerParts = [];
  if (context.mode === "1" && context.tracker) {
    if (context.tracker.comments) {
      trackerParts.push(`\nRelated comments:\n${context.tracker.comments}`);
    }
    if (context.tracker.linkedIssues) {
      trackerParts.push(`\nLinked issues:\n${context.tracker.linkedIssues}`);
    }
    if (context.tracker.screenshots) {
      trackerParts.push(`\nScreenshots:\n${context.tracker.screenshots}`);
    }
  }

  let designDocPath = context.designDocPath || null;
  let executionPlanPath = context.executionPlanPath || null;
  let figmaContextPath = context.figmaContextPath || null;
  if (!designDocPath && context.vaultFolder) {
    const docs = discoverVaultDocPaths(context.vaultFolder);
    designDocPath = docs.designDoc;
    executionPlanPath = executionPlanPath || docs.executionPlan;
    figmaContextPath = figmaContextPath || docs.figmaContext;
  }

  const designDocSection = designDocPath
    ? `\nDesign document: ${designDocPath} (read this file yourself with the Read tool)\n`
    : "";

  const executionPlanSection = executionPlanPath
    ? `\nExecution plan: ${executionPlanPath} (read this file yourself with the Read tool)\n`
    : "";

  const figmaSection = figmaContextPath
    ? `\nFigma design data: ${figmaContextPath} (read this file yourself with the Read tool)\nFollow the common-skills:figma-execute skill standards for UI implementation based on this Figma context.\n`
    : "";

  const executionDirective = context.mode === "3"
    ? "Implement strictly according to the description above."
    : "Implement strictly according to the execution plan document.";

  const extraGuidanceSection = context.extraGuidance
    ? `\n<extra_guidance>\n${context.extraGuidance}\n</extra_guidance>\n`
    : "";

  return interpolateTemplate(template, {
    TASK_ID: context.taskId || "n/a (direct prompt mode)",
    MODE: `Mode ${context.mode}`,
    SUMMARY: context.summary || "",
    TRACKER_METADATA: trackerMetadata,
    SOURCE: context.source || "direct prompt",
    DESCRIPTION: description,
    TRACKER_CONTEXT: trackerParts.join("\n"),
    DESIGN_DOC_SECTION: designDocSection,
    EXECUTION_PLAN_SECTION: executionPlanSection,
    FIGMA_SECTION: figmaSection,
    EXECUTION_DIRECTIVE: executionDirective,
    REPO_PATH: context.repoPath || process.cwd(),
    EXTRA_GUIDANCE_SECTION: extraGuidanceSection
  });
}


function buildExecuteTestPrompt(context) {
  const template = loadPromptTemplate(ROOT_DIR, "execute-test");

  const implFileLines = (context.implFiles || []).map((f) => `  - ${f}`).join("\n");

  let testPlanPath = context.testPlanPath || null;
  if (!testPlanPath && context.vaultFolder) {
    const candidate = path.join(context.vaultFolder, "test-plan.md");
    if (fs.existsSync(candidate)) testPlanPath = candidate;
  }

  let designDocPath = context.designDocPath || null;
  if (!designDocPath && context.vaultFolder) {
    const docs = discoverVaultDocPaths(context.vaultFolder);
    designDocPath = docs.designDoc;
  }
  const designDocSection = designDocPath
    ? `Design document (source of truth for intended behavior): ${designDocPath} (read this file yourself with the Read tool)`
    : "";

  const testCodeSkillSection = "\nFollow the common-skills:test-code skill standards when writing tests.\n";

  return interpolateTemplate(template, {
    TEST_PLAN_PATH: testPlanPath || "",
    DESIGN_DOC_SECTION: designDocSection,
    IMPL_FILES_LIST: implFileLines,
    REPO_PATH: context.repoPath || process.cwd(),
    TEST_CODE_SKILL_SECTION: testCodeSkillSection
  });
}

function buildExecuteFixPrompt(context) {
  const template = loadPromptTemplate(ROOT_DIR, "execute-fix");

  const testFileLines = (context.testFiles || []).map((f) => `  - ${f}`).join("\n");
  const implFileLines = (context.implFiles || []).map((f) => `  - ${f}`).join("\n");

  return interpolateTemplate(template, {
    TEST_FILES_LIST: testFileLines,
    IMPL_FILES_LIST: implFileLines,
    REPO_PATH: context.repoPath || process.cwd()
  });
}

function ensureCodexAvailable(cwd) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }
}

function buildNativeReviewTarget(target) {
  if (target.mode === "working-tree") {
    return { type: "uncommittedChanges" };
  }

  if (target.mode === "branch") {
    return { type: "baseBranch", branch: target.baseRef };
  }

  return null;
}

function validateNativeReviewRequest(target, focusText) {
  if (focusText.trim()) {
    throw new Error(
      `\`/codex:review\` now maps directly to the built-in reviewer and does not support custom focus text. Retry with \`/codex:adversarial-review ${focusText.trim()}\` for focused review instructions.`
    );
  }

  const nativeTarget = buildNativeReviewTarget(target);
  if (!nativeTarget) {
    throw new Error("This `/codex:review` target is not supported by the built-in reviewer. Retry with `/codex:adversarial-review` for custom targeting.");
  }

  return nativeTarget;
}

function renderStatusPayload(report, asJson) {
  return asJson ? report : renderStatusReport(report);
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

function getCurrentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentClaudeSession(jobs) {
  const sessionId = getCurrentClaudeSessionId();
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function findLatestResumableTaskJob(jobs, options = {}) {
  const kind = options.kind ?? null;
  return (
    jobs.find(
      (job) =>
        job.jobClass === "task" &&
        job.threadId &&
        job.status !== "queued" &&
        job.status !== "running" &&
        (kind == null || job.kind === kind)
    ) ?? null
  );
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);
  options.onSnapshot?.(snapshot);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
    options.onSnapshot?.(snapshot);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

function buildAwaitProgressPayload(snapshot) {
  const { job } = snapshot;
  return {
    event: "progress",
    job: {
      id: job.id,
      title: job.title ?? null,
      kind: job.kindLabel ?? job.kind ?? null,
      status: job.status,
      phase: job.phase ?? null,
      elapsed: job.elapsed ?? null,
      lastActivityAt: job.lastActivityAt ?? null,
      lastActivityAgo: job.lastActivityAgo ?? null,
      workerAlive: job.workerAlive ?? null,
      lastMessage: job.lastMessage ?? null,
      lastMessageSource: job.lastMessageSource ?? null,
      changeSummary: job.changeSummary ?? null,
      progressPreview: job.progressPreview ?? []
    }
  };
}

function renderMonitorState(job) {
  const worker = job.workerAlive === true ? "alive" : job.workerAlive === false ? "stopped" : "starting";
  const elapsed = job.elapsed ? ` after ${job.elapsed}` : "";
  const phase = job.phase ? `, phase ${job.phase}` : "";
  return `Codex job ${job.id} is ${job.status}${phase}${elapsed}; worker ${worker}. Use /codex:status ${job.id} for details.`;
}

function renderMonitorTerminal(job) {
  const duration = job.duration ?? job.elapsed;
  const elapsed = duration ? ` after ${duration}` : "";
  return `Codex job ${job.id} ${job.status}${elapsed}. Fetch the stored output with /codex:result ${job.id}.`;
}

async function resolveLatestTrackedTaskThread(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionId = getCurrentClaudeSessionId();
  const kind = options.kind ?? null;
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter((job) => job.id !== options.excludeJobId);
  const visibleJobs = filterJobsForCurrentClaudeSession(jobs);
  const activeTask = visibleJobs.find((job) => job.jobClass === "task" && (job.status === "queued" || job.status === "running") && (kind == null || job.kind === kind));
  if (activeTask) {
    throw new Error(`Task ${activeTask.id} is still running. Use /codex:status before continuing it.`);
  }

  const trackedTask = findLatestResumableTaskJob(visibleJobs, { kind });
  if (trackedTask) {
    return { id: trackedTask.threadId };
  }

  if (sessionId) {
    return null;
  }

  if (kind != null) {
    return null;
  }

  return findLatestTaskThread(workspaceRoot);
}

async function executeReviewRun(request) {
  ensureCodexAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";
  if (reviewName === "Review") {
    const reviewTarget = validateNativeReviewRequest(target, focusText);
    const result = await runAppServerReview(request.cwd, {
      target: reviewTarget,
      model: request.model,
      onProgress: request.onProgress
    });
    const payload = {
      review: reviewName,
      target,
      threadId: result.threadId,
      sourceThreadId: result.sourceThreadId,
      codex: {
        status: result.status,
        stderr: result.stderr,
        stdout: result.reviewText,
        reasoning: result.reasoningSummary
      }
    };
    const rendered = renderNativeReviewResult(
      {
        status: result.status,
        stdout: result.reviewText,
        stderr: result.stderr
      },
      { reviewLabel: reviewName, targetLabel: target.label, reasoningSummary: result.reasoningSummary }
    );

    return {
      exitStatus: result.status,
      threadId: result.threadId,
      turnId: result.turnId,
      payload,
      rendered,
      summary: firstMeaningfulLine(result.reviewText, `${reviewName} completed.`),
      jobTitle: `Codex ${reviewName}`,
      jobClass: "review",
      targetLabel: target.label
    };
  }

  const context = collectReviewContext(request.cwd, target);
  const prompt = buildAdversarialReviewPrompt(context, focusText);
  const result = await runAppServerTurn(context.repoRoot, {
    prompt,
    model: request.model,
    effort: request.effort,
    sandbox: "read-only",
    outputSchema: readOutputSchema(REVIEW_SCHEMA),
    onProgress: request.onProgress
  });
  const parsed = parseStructuredOutput(result.finalMessage, {
    status: result.status,
    failureMessage: result.error?.message ?? result.stderr
  });
  const payload = {
    review: reviewName,
    target,
    threadId: result.threadId,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary
    },
    codex: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.finalMessage,
      reasoning: result.reasoningSummary
    },
    result: parsed.parsed,
    rawOutput: parsed.rawOutput,
    parseError: parsed.parseError,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered: renderReviewResult(parsed, {
      reviewLabel: reviewName,
      targetLabel: context.target.label,
      reasoningSummary: result.reasoningSummary
    }),
    summary: parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`),
    jobTitle: `Codex ${reviewName}`,
    jobClass: "review",
    targetLabel: context.target.label
  };
}

async function executeDocumentReviewRun(request) {
  ensureCodexAvailable(request.cwd);

  const reviewName = request.reviewName;
  const context = collectVaultDocumentContext(request.vaultFolder, {
    primaryDoc: request.primaryDoc,
    includeRelated: request.includeRelated
  });
  const focusText = request.focusText?.trim() ?? "";

  const isTestPlanReview = reviewName === "Test Plan Review";
  const isDesignReview = reviewName === "Design Review";
  const prompt = isDesignReview
    ? buildDesignReviewPrompt(context, focusText)
    : buildTestPlanReviewPrompt(context, focusText);

  const schemaPath = isDesignReview ? DESIGN_REVIEW_SCHEMA : isTestPlanReview ? TEST_PLAN_REVIEW_SCHEMA : REVIEW_SCHEMA;
  const result = await runAppServerTurn(request.cwd, {
    prompt,
    model: request.model,
    effort: request.effort,
    sandbox: "read-only",
    outputSchema: readOutputSchema(schemaPath),
    onProgress: request.onProgress
  });

  const parsed = parseStructuredOutput(result.finalMessage, {
    status: result.status,
    failureMessage: result.error?.message ?? result.stderr
  });

  const payload = {
    review: reviewName,
    target: context.target,
    threadId: result.threadId,
    context: {
      vaultFolder: context.vaultFolder,
      primaryDoc: context.primaryDoc,
      filesRead: context.filesRead
    },
    codex: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.finalMessage,
      reasoning: result.reasoningSummary
    },
    result: parsed.parsed,
    rawOutput: parsed.rawOutput,
    parseError: parsed.parseError,
    reasoningSummary: result.reasoningSummary
  };

  const renderFn = isDesignReview ? renderDesignReviewResult : isTestPlanReview ? renderTestPlanReviewResult : renderReviewResult;
  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered: renderFn(parsed, {
      reviewLabel: reviewName,
      targetLabel: context.target.label,
      reasoningSummary: result.reasoningSummary
    }),
    summary: parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`),
    jobTitle: `Codex ${reviewName}`,
    jobClass: "review",
    targetLabel: context.target.label
  };
}


async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureCodexAvailable(request.cwd);

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: request.resumeLast
  });

  let resumeThreadId = null;
  if (request.resumeLast) {
    const latestThread = await resolveLatestTrackedTaskThread(workspaceRoot, {
      excludeJobId: request.jobId,
      kind: request.kind ?? null
    });
    if (!latestThread) {
      throw new Error("No previous Codex task thread was found for this repository.");
    }
    resumeThreadId = latestThread.id;
  }

  if (!request.prompt && !resumeThreadId) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  const result = await runAppServerTurn(workspaceRoot, {
    resumeThreadId,
    prompt: request.prompt,
    defaultPrompt: resumeThreadId ? DEFAULT_CONTINUE_PROMPT : "",
    model: request.model,
    effort: request.effort,
    sandbox: request.write ? "workspace-write" : "read-only",
    onProgress: request.onProgress,
    persistThread: true,
    threadName: resumeThreadId ? null : buildPersistentTaskThreadName(request.prompt || DEFAULT_CONTINUE_PROMPT)
  });

  const rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";
  const failureMessage = result.error?.message ?? result.stderr ?? "";
  const rendered = renderTaskResult(
    {
      rawOutput,
      failureMessage,
      reasoningSummary: result.reasoningSummary
    },
    {
      title: taskMetadata.title,
      jobId: request.jobId ?? null,
      write: Boolean(request.write)
    }
  );
  const payload = {
    status: result.status,
    threadId: result.threadId,
    rawOutput,
    touchedFiles: result.touchedFiles,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write: Boolean(request.write)
  };
}

function buildReviewJobMetadata(reviewName, target) {
  const kindMap = {
    "Review": "review",
    "Adversarial Review": "adversarial-review",
    "Design Review": "design-review",
    "Test Plan Review": "test-plan-review"
  };
  return {
    kind: kindMap[reviewName] ?? "review",
    title: reviewName === "Review" ? "Codex Review" : `Codex ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

function buildTaskRunMetadata({ prompt, resumeLast = false }) {
  if (!resumeLast && String(prompt ?? "").includes(STOP_REVIEW_TASK_MARKER)) {
    return {
      title: "Codex Stop Gate Review",
      summary: "Stop-gate review of previous Claude turn"
    };
  }

  const title = resumeLast ? "Codex Resume" : "Codex Task";
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task";
  return {
    title,
    summary: shorten(prompt || fallbackSummary)
  };
}

function renderQueuedJobLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check /codex:status ${payload.jobId} for progress.\n`;
}

function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review" || kind === "design-review" || kind === "test-plan-review") {
    return kind;
  }
  if (kind === "task" && jobClass === "task") {
    return "rescue";
  }
  return jobClass === "review" ? "review" : "rescue";
}

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: getJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

function buildTaskJob(workspaceRoot, taskMetadata, write, kind = "task") {
  return createCompanionJob({
    prefix: "task",
    kind,
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write
  });
}

function buildTaskRequest({ cwd, model, effort, prompt, write, resumeLast, jobId, kind }) {
  return {
    runner: "task",
    cwd,
    model,
    effort,
    prompt,
    write,
    resumeLast,
    kind,
    jobId
  };
}

function renderTransferResult(payload) {
  const lines = [
    "Transferred the Claude session into a Codex thread with visible turn history.",
    `Codex session ID: ${payload.threadId}`,
    `Resume in Codex: ${payload.resumeCommand}`
  ];
  return `${lines.join("\n")}\n`;
}

async function executeTransfer(cwd, options = {}) {
  const sourcePath = resolveClaudeSessionPath(cwd, {
    source: options.source
  });
  const result = await importExternalAgentSession(cwd, { sourcePath });
  const payload = {
    threadId: result.threadId,
    resumeCommand: `codex resume ${result.threadId}`,
    sourcePath,
    sessionId: path.basename(sourcePath, ".jsonl")
  };

  return {
    payload,
    rendered: renderTransferResult(payload)
  };
}

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }

  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

function requireTaskRequest(prompt, resumeLast) {
  if (!prompt && !resumeLast) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json
  });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function spawnDetachedJobWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "codex-companion.mjs");
  const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

function enqueueBackgroundJob(cwd, job, request) {
  reconcileActiveJobs(job.workspaceRoot);
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");
  const queuedAt = nowIso();

  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    queuedAt,
    pid: null,
    workerPid: null,
    lastActivityAt: queuedAt,
    logFile,
    request
  };
  updateJobRecord(job.workspaceRoot, job.id, (current) => {
    if (current) {
      throw new Error(`Job ${job.id} already exists.`);
    }
    return queuedRecord;
  });

  let child;
  try {
    child = spawnDetachedJobWorker(cwd, job.id);
  } catch (error) {
    const completedAt = nowIso();
    const errorMessage = error instanceof Error ? error.message : String(error);
    updateJobRecord(job.workspaceRoot, job.id, (current) => {
      if (!current || (current.status !== "queued" && current.status !== "running")) {
        return null;
      }
      return {
        ...current,
        status: "failed",
        phase: "failed",
        completedAt,
        errorMessage
      };
    });
    throw error;
  }

  updateJobRecord(job.workspaceRoot, job.id, (current) => {
    if (!current || (current.status !== "queued" && current.status !== "running")) {
      return null;
    }
    return {
      ...current,
      pid: child.pid ?? current.pid ?? null,
      workerPid: child.pid ?? current.workerPid ?? null
    };
  });

  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile
    },
    logFile
  };
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "effort", "cwd"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });
  validateExecutionMode(options);

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = normalizeRequestedModel(options.model);
  const effort = normalizeReasoningEffort(options.effort);
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  config.validateRequest?.(target, focusText);
  if (config.reviewName === "Review" && effort != null) {
    throw new Error(`/codex:review does not support --effort. Use /codex:adversarial-review for a steerable review turn.`);
  }
  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createCompanionJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary
  });

  const request = {
    runner: "review",
    cwd,
    base: options.base,
    scope: options.scope,
    model,
    effort,
    focusText,
    reviewName: config.reviewName
  };

  if (options.background) {
    ensureCodexAvailable(cwd);
    const { payload } = enqueueBackgroundJob(cwd, job, request);
    outputCommandResult(payload, renderQueuedJobLaunch(payload), options.json);
    return;
  }

  await runForegroundCommand(
    job,
    (progress) => executeReviewRun({ ...request, onProgress: progress }),
    { json: options.json }
  );
}

async function handleDocumentReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["path", "task", "model", "effort", "cwd"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      m: "model",
      p: "path",
      t: "task"
    }
  });
  validateExecutionMode(options);

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = normalizeRequestedModel(options.model ?? config.defaultModel);
  const effort = normalizeReasoningEffort(options.effort ?? config.defaultEffort);
  const focusText = positionals.join(" ").trim();

  let vaultFolder;
  if (options.path) {
    vaultFolder = path.resolve(cwd, options.path);
  } else if (options.task) {
    vaultFolder = resolveVaultTaskFolder(options.task);
  } else {
    throw new Error(
      `Provide --path <vault-folder> or --task <task-id> to specify the document location.`
    );
  }

  const folderName = path.basename(vaultFolder);
  const parentName = path.basename(path.dirname(vaultFolder));
  const targetLabel = `${config.primaryDoc} in ${parentName}/${folderName}`;

  const job = createCompanionJob({
    prefix: "review",
    kind: config.kind,
    title: `Codex ${config.reviewName}`,
    workspaceRoot,
    jobClass: "review",
    summary: `${config.reviewName} of ${targetLabel}`
  });

  const request = {
    runner: "document-review",
    cwd,
    vaultFolder,
    primaryDoc: config.primaryDoc,
    includeRelated: config.includeRelated,
    model,
    effort,
    focusText,
    reviewName: config.reviewName
  };

  if (options.background) {
    ensureCodexAvailable(cwd);
    const { payload } = enqueueBackgroundJob(cwd, job, request);
    outputCommandResult(payload, renderQueuedJobLaunch(payload), options.json);
    return;
  }

  await runForegroundCommand(
    job,
    (progress) => executeDocumentReviewRun({ ...request, onProgress: progress }),
    { json: options.json }
  );
}

async function handleExecute(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["context-file", "model", "effort", "cwd", "phase", "path", "task"],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background", "wait"],
    aliasMap: {
      m: "model",
      f: "context-file",
      p: "phase",
      t: "task"
    }
  });
  validateExecutionMode(options);

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = normalizeRequestedModel(options.model);
  const effort = normalizeReasoningEffort(options.effort);
  const write = options.write !== false;
  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  if (resumeLast && fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }

  const phase = options.phase || "implement";
  const phaseKindMap = { implement: "execute", "write-tests": "execute-test", "fix-tests": "execute-fix" };
  const kind = phaseKindMap[phase];
  if (!kind) {
    throw new Error(`Unknown phase: ${phase}. Use implement, write-tests, or fix-tests.`);
  }

  const contextFilePath = options["context-file"];
  let prompt;
  let phaseLabel;

  if (resumeLast && !contextFilePath) {
    prompt = positionals.join(" ") || readStdinIfPiped() || null;
    phaseLabel = "Resume";
  } else {
    if (!contextFilePath) {
      throw new Error("--context-file is required for initial execution. Use --resume-last for continuation.");
    }
    const context = readContextFile(cwd, contextFilePath);

    if (options.task && !context.vaultFolder) {
      context.vaultFolder = resolveVaultTaskFolder(options.task);
    } else if (options.path && !context.vaultFolder) {
      context.vaultFolder = path.resolve(cwd, options.path);
    }

    switch (phase) {
      case "implement":
        prompt = buildExecutePrompt(context);
        phaseLabel = "Implement";
        break;
      case "write-tests":
        prompt = buildExecuteTestPrompt(context);
        phaseLabel = "Write Tests";
        break;
      case "fix-tests":
        prompt = buildExecuteFixPrompt(context);
        phaseLabel = "Fix Tests";
        break;
    }
  }

  const taskMetadata = {
    title: `Codex Execute (${phaseLabel})`,
    summary: shorten(prompt || phaseLabel)
  };

  if (options.background) {
    ensureCodexAvailable(cwd);
    const job = buildTaskJob(workspaceRoot, taskMetadata, write, kind);
    const request = buildTaskRequest({ cwd, model, effort, prompt, write, resumeLast, jobId: job.id, kind });
    const { payload } = enqueueBackgroundJob(cwd, job, request);
    outputCommandResult(payload, renderQueuedJobLaunch(payload), options.json);
    return;
  }

  const job = buildTaskJob(workspaceRoot, taskMetadata, write, kind);
  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({
        cwd,
        model,
        effort,
        prompt,
        write,
        kind,
        resumeLast,
        jobId: job.id,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleReview(argv) {
  return handleReviewCommand(argv, {
    reviewName: "Review",
    validateRequest: validateNativeReviewRequest
  });
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file"],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });
  validateExecutionMode(options);

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = normalizeRequestedModel(options.model);
  const effort = normalizeReasoningEffort(options.effort);
  const prompt = readTaskPrompt(cwd, options, positionals);

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  if (resumeLast && fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  const write = Boolean(options.write);
  const taskMetadata = buildTaskRunMetadata({
    prompt,
    resumeLast
  });

  if (options.background) {
    ensureCodexAvailable(cwd);
    requireTaskRequest(prompt, resumeLast);

    const job = buildTaskJob(workspaceRoot, taskMetadata, write);
    const request = buildTaskRequest({
      cwd,
      model,
      effort,
      prompt,
      write,
      resumeLast,
      jobId: job.id
    });
    const { payload } = enqueueBackgroundJob(cwd, job, request);
    outputCommandResult(payload, renderQueuedJobLaunch(payload), options.json);
    return;
  }

  const job = buildTaskJob(workspaceRoot, taskMetadata, write);
  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({
        cwd,
        model,
        effort,
        prompt,
        write,
        resumeLast,
        jobId: job.id,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleTransfer(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "source"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const { payload, rendered } = await executeTransfer(cwd, {
    source: options.source
  });
  outputCommandResult(payload, rendered, options.json);
}

function executeStoredJobRequest(request, progress) {
  const runRequest = { ...request, onProgress: progress };
  switch (request.runner ?? "task") {
    case "task":
      return executeTaskRun(runRequest);
    case "review":
      return executeReviewRun(runRequest);
    case "document-review":
      return executeDocumentReviewRun(runRequest);
    default:
      throw new Error(`Stored job has an unsupported runner: ${request.runner}.`);
  }
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its request payload.`);
  }

  const { logFile, progress } = createTrackedProgress(
    {
      ...storedJob,
      workspaceRoot
    },
    {
      logFile: storedJob.logFile ?? null
    }
  );
  await runTrackedJob(
    {
      ...storedJob,
      workspaceRoot,
      logFile
    },
    () => executeStoredJobRequest(request, progress),
    { logFile, requireExisting: true }
  );
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(renderStatusPayload(report, options.json), options.json);
}

async function handleAwaitResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "jsonl", "monitor"]
  });

  if ([options.json, options.jsonl, options.monitor].filter(Boolean).length > 1) {
    throw new Error("Choose only one of --json, --jsonl, or --monitor.");
  }

  const outputAwaitResult = (payload, rendered, event) => {
    if (options.jsonl) {
      console.log(JSON.stringify({ event, ...payload }));
      return;
    }
    outputCommandResult(payload, rendered, options.json);
  };

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (!reference) {
    throw new Error("`await-result` requires a job id.");
  }

  let lastProgressFingerprint = null;
  let monitorBaselineInitialized = false;
  const emitProgressSnapshot = (progressSnapshot) => {
    if ((!options.jsonl && !options.monitor) || !isActiveJobStatus(progressSnapshot.job.status)) {
      return;
    }
    const payload = buildAwaitProgressPayload(progressSnapshot);
    const fingerprint = options.monitor
      ? JSON.stringify({
          status: payload.job.status,
          workerAlive: payload.job.workerAlive
        })
      : JSON.stringify({
          status: payload.job.status,
          phase: payload.job.phase,
          lastActivityAt: payload.job.lastActivityAt,
          workerAlive: payload.job.workerAlive,
          lastMessage: payload.job.lastMessage,
          lastMessageSource: payload.job.lastMessageSource,
          changeSummary: payload.job.changeSummary,
          progressPreview: payload.job.progressPreview
        });
    if (options.monitor && !monitorBaselineInitialized) {
      monitorBaselineInitialized = true;
      lastProgressFingerprint = fingerprint;
      return;
    }
    if (fingerprint === lastProgressFingerprint) {
      return;
    }
    lastProgressFingerprint = fingerprint;
    console.log(options.monitor ? renderMonitorState(payload.job) : JSON.stringify(payload));
  };

  const snapshot = await waitForSingleJobSnapshot(cwd, reference, {
    timeoutMs: options["timeout-ms"] ?? DEFAULT_AWAIT_RESULT_TIMEOUT_MS,
    pollIntervalMs: options["poll-interval-ms"],
    onSnapshot: emitProgressSnapshot
  });

  if (snapshot.waitTimedOut) {
    if (options.monitor) {
      console.log(
        `Codex watcher timed out after ${snapshot.job.elapsed ?? "the configured limit"}; job ${snapshot.job.id} is still ${snapshot.job.status}. Use /codex:status ${snapshot.job.id}.`
      );
      process.exitCode = 2;
      return;
    }
    const payload = {
      ...snapshot,
      error: `Timed out waiting for ${snapshot.job.id} to finish.`
    };
    outputAwaitResult(payload, renderJobStatusReport(snapshot.job), "timeout");
    process.exitCode = 2;
    return;
  }

  if (options.monitor) {
    console.log(renderMonitorTerminal(snapshot.job));
    if (snapshot.job.status !== "completed") {
      process.exitCode = 1;
    }
    return;
  }

  const storedJob = readStoredJob(snapshot.workspaceRoot, snapshot.job.id);
  const payload = {
    job: snapshot.job,
    storedJob
  };
  outputAwaitResult(payload, renderStoredJobResult(snapshot.job, storedJob), "result");
  if (snapshot.job.status !== "completed") {
    process.exitCode = 1;
  }
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = {
    job,
    storedJob
  };

  outputCommandResult(payload, renderStoredJobResult(job, storedJob), options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
  const candidate = findLatestResumableTaskJob(jobs);

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            threadId: candidate.threadId,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };

  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable task found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};
  const threadId = existing.threadId ?? job.threadId ?? null;
  const turnId = existing.turnId ?? job.turnId ?? null;

  const interrupt = await interruptAppServerTurn(cwd, { threadId, turnId });
  if (interrupt.attempted) {
    appendLogLine(
      job.logFile,
      interrupt.interrupted
        ? `Requested Codex turn interrupt for ${turnId} on ${threadId}.`
        : `Codex turn interrupt failed${interrupt.detail ? `: ${interrupt.detail}` : "."}`
    );
  }

  const workerPid = existing.pid ?? existing.workerPid ?? job.pid ?? job.workerPid ?? Number.NaN;
  let termination;
  try {
    termination = terminateProcessTree(workerPid);
  } catch (error) {
    termination = {
      attempted: true,
      delivered: false,
      method: null,
      detail: error instanceof Error ? error.message : String(error)
    };
  }

  const completedAt = nowIso();
  const cancellationDelivered = interrupt.interrupted || termination.delivered;
  if (!cancellationDelivered) {
    const detail = [interrupt.detail, termination.detail].filter(Boolean).join("; ");
    const errorMessage = `Cancellation was not delivered for ${job.id}${detail ? `: ${detail}` : "."}`;
    appendLogLine(job.logFile, errorMessage);

    const hasValidWorkerPid = Number.isInteger(workerPid) && workerPid > 0;
    const workerUnavailable = !hasValidWorkerPid || (!termination.delivered && !termination.detail);
    if (!workerUnavailable) {
      updateJobRecord(workspaceRoot, job.id, (current) => {
        if (!current || !isActiveJobStatus(current.status)) {
          return null;
        }
        return {
          ...current,
          cancellationAttemptedAt: completedAt,
          cancellationError: errorMessage
        };
      });
      throw new Error(errorMessage);
    }

    updateJobRecord(workspaceRoot, job.id, (current) => {
      if (!current || !isActiveJobStatus(current.status)) {
        return null;
      }
      return {
        ...current,
        status: "failed",
        phase: "failed",
        pid: null,
        completedAt,
        errorMessage
      };
    });
    throw new Error(errorMessage);
  }

  const nextJob = updateJobRecord(workspaceRoot, job.id, (current) => {
    if (!current || !isActiveJobStatus(current.status)) {
      return null;
    }
    return {
      ...current,
      status: "cancelled",
      phase: "cancelled",
      pid: null,
      completedAt,
      cancelledAt: completedAt,
      errorMessage: "Cancelled by user."
    };
  });
  if (!nextJob) {
    const latest = readStoredJob(workspaceRoot, job.id);
    throw new Error(`Job ${job.id} reached ${latest?.status ?? "an unknown state"} before cancellation was recorded.`);
  }
  appendLogLine(job.logFile, "Cancelled by user.");

  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title,
    turnInterruptAttempted: interrupt.attempted,
    turnInterrupted: interrupt.interrupted,
    processTerminationAttempted: termination.attempted,
    processTerminationDelivered: termination.delivered,
    processTerminationMethod: termination.method
  };

  outputCommandResult(payload, renderCancelReport(nextJob), options.json);
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, {
        reviewName: "Adversarial Review"
      });
      break;
    case "design-review":
      await handleDocumentReviewCommand(argv, {
        reviewName: "Design Review",
        kind: "design-review",
        primaryDoc: "plan.md",
        includeRelated: false,
        defaultModel: "gpt-5.6-sol",
        defaultEffort: "max"
      });
      break;
    case "test-plan-review":
      await handleDocumentReviewCommand(argv, {
        reviewName: "Test Plan Review",
        kind: "test-plan-review",
        primaryDoc: "test-plan.md",
        includeRelated: true
      });
      break;
    case "execute":
      await handleExecute(["--phase", "implement", ...argv]);
      break;
    case "execute-test":
      await handleExecute(["--phase", "write-tests", ...argv]);
      break;
    case "execute-fix":
      await handleExecute(["--phase", "fix-tests", ...argv]);
      break;
    case "task":
      await handleTask(argv);
      break;
    case "transfer":
      await handleTransfer(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "await-result":
      await handleAwaitResult(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
