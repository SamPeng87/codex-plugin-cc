import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DEFAULT_VAULT_BASE = path.join(os.homedir(), "obsidian", "sam");
const KNOWN_DOC_FILES = ["plan.md", "test-plan.md", "root-cause.md", "fix-plan.md", "insight.md"];

export function resolveVaultTaskFolder(taskId) {
  const projectsDir = path.join(DEFAULT_VAULT_BASE, "projects");
  if (!fs.existsSync(projectsDir)) {
    throw new Error(`Vault projects directory not found: ${projectsDir}`);
  }

  const projects = fs.readdirSync(projectsDir).filter((name) => {
    return fs.statSync(path.join(projectsDir, name)).isDirectory();
  });

  for (const project of projects) {
    for (const category of ["features", "bugs"]) {
      const candidate = path.join(projectsDir, project, category, taskId);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        return candidate;
      }
    }
  }

  throw new Error(
    `Task folder for "${taskId}" not found in vault at ${projectsDir}. ` +
      `Searched projects/*/features/${taskId}/ and projects/*/bugs/${taskId}/.`
  );
}

function readDocIfExists(folder, filename) {
  const filePath = path.join(folder, filename);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, "utf8");
}

function formatDocSection(title, content) {
  return [`## ${title}`, "", content.trim() || "(empty)", ""].join("\n");
}

export function addLineNumbers(content) {
  const lines = content.split("\n");
  const width = String(lines.length).length;
  return lines
    .map((line, i) => `L${String(i + 1).padStart(Math.max(width, 3), "0")}: ${line}`)
    .join("\n");
}

function extractFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const props = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^(\w[\w-]*):\s*"?(.+?)"?\s*$/);
    if (kv) props[kv[1]] = kv[2];
  }
  return props;
}

export function collectVaultDocumentContext(vaultFolder, options = {}) {
  const primaryDocName = options.primaryDoc || "plan.md";
  const includeRelated = options.includeRelated || false;

  if (!fs.existsSync(vaultFolder)) {
    throw new Error(`Vault folder not found: ${vaultFolder}`);
  }

  const primaryContent = readDocIfExists(vaultFolder, primaryDocName);
  if (!primaryContent) {
    throw new Error(`Primary document "${primaryDocName}" not found in ${vaultFolder}`);
  }

  const frontmatter = extractFrontmatter(primaryContent);
  const folderName = path.basename(vaultFolder);
  const parentName = path.basename(path.dirname(vaultFolder));
  const filesRead = [primaryDocName];
  const parts = [];

  if (primaryDocName === "test-plan.md" && includeRelated) {
    const designContent = readDocIfExists(vaultFolder, "plan.md");
    if (designContent) {
      parts.push(formatDocSection("Design Document (plan.md)", designContent));
      filesRead.push("plan.md");
    }
    parts.push(formatDocSection("Test Plan (test-plan.md)", primaryContent));
  } else {
    parts.push(formatDocSection(`Document (${primaryDocName})`, primaryContent));
  }

  for (const docFile of KNOWN_DOC_FILES) {
    if (docFile === primaryDocName) continue;
    if (includeRelated && docFile === "plan.md") continue;
    const content = readDocIfExists(vaultFolder, docFile);
    if (content) {
      parts.push(formatDocSection(`Related: ${docFile}`, content));
      filesRead.push(docFile);
    }
  }

  const projectParts = [];
  if (frontmatter["task-id"]) projectParts.push(`Task ID: ${frontmatter["task-id"]}`);
  if (frontmatter.project) projectParts.push(`Project: ${frontmatter.project}`);
  if (frontmatter.language) projectParts.push(`Language: ${frontmatter.language}`);
  if (frontmatter.modules) projectParts.push(`Modules: ${frontmatter.modules}`);

  const result = {
    vaultFolder,
    primaryDoc: primaryDocName,
    filesRead,
    target: {
      label: `${primaryDocName} in ${parentName}/${folderName}`,
      mode: "vault-document"
    },
    content: parts.join("\n"),
    projectContext: projectParts.join("\n") || "",
    summary: `Reviewing ${primaryDocName} in ${parentName}/${folderName} (${filesRead.length} file(s) read).`
  };

  const relatedParts = [];
  for (const docFile of KNOWN_DOC_FILES) {
    if (docFile === primaryDocName) continue;
    if (includeRelated && docFile === "plan.md") continue;
    const relContent = readDocIfExists(vaultFolder, docFile);
    if (relContent) {
      relatedParts.push(formatDocSection(`Related: ${docFile}`, relContent));
    }
  }
  result.relatedContent = relatedParts.join("\n");

  if (primaryDocName === "plan.md") {
    result.planContent = primaryContent;
  }

  if (primaryDocName === "test-plan.md") {
    result.testPlanContent = primaryContent;
    result.designContext = readDocIfExists(vaultFolder, "plan.md") || "";
  }

  return result;
}
