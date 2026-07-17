import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { appDataDir } from "@embedded/db";

/**
 * The KiCad symbol library as a managed on-disk clone. The library is the
 * Channel-1 breadth source: ~23k permissively-licensed symbols, each with pins
 * and a datasheet URL. It is fetched with a shallow clone (history is useless
 * to us) into the app's data dir, so a re-import is just a `git pull`.
 */
const REPO_URL = "https://gitlab.com/kicad/libraries/kicad-symbols.git";

export function kicadCloneDir(): string {
  return join(appDataDir(), "sources", "kicad-symbols");
}

/** Run git, streaming its progress lines (git writes progress to stderr). */
function git(args: string[], onLine?: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      const line = text.split(/[\r\n]+/).filter(Boolean).pop();
      if (line && onLine) onLine(line.trim());
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      reject(
        err.code === "ENOENT"
          ? new Error("git was not found on PATH. Install git, or import from an existing directory.")
          : err,
      );
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git ${args[0]} failed (exit ${code}): ${stderr.slice(-500)}`));
    });
  });
}

/**
 * Ensure the KiCad symbol library is present on disk and return its path,
 * cloning it the first time and pulling on later calls. `onProgress` receives
 * git's progress lines so the import job can surface "Receiving objects…".
 */
export async function ensureKicadClone(onProgress?: (line: string) => void): Promise<string> {
  const dir = kicadCloneDir();
  if (existsSync(join(dir, ".git"))) {
    onProgress?.("updating existing clone…");
    await git(["-C", dir, "pull", "--depth", "1", "--ff-only"], onProgress);
    return dir;
  }
  mkdirSync(dirname(dir), { recursive: true });
  onProgress?.("cloning KiCad symbol library…");
  await git(["clone", "--depth", "1", REPO_URL, dir], onProgress);
  return dir;
}
