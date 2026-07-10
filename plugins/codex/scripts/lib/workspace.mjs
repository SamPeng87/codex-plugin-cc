import fs from "node:fs";
import path from "node:path";

import { ensureGitRepository } from "./git.mjs";

export function resolveWorkspaceRoot(cwd) {
  try {
    return ensureGitRepository(cwd);
  } catch {
    return cwd;
  }
}

export function resolveCanonicalWorkspaceRoot(cwd) {
  const workspaceRoot = path.resolve(resolveWorkspaceRoot(cwd));
  try {
    return fs.realpathSync.native(workspaceRoot);
  } catch {
    return workspaceRoot;
  }
}
