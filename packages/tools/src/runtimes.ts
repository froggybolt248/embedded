import { execa } from "execa";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Presence of an LLM-runtime CLI on the host. Same contract as detectProbeRs:
 * `present: false` is the honest first-run answer, never an error, and this
 * NEVER throws — it decides which doors an onboarding screen offers.
 */
export interface RuntimeCli {
  present: boolean;
  version?: string;
  detail?: string;
}

const VERSION_TIMEOUT_MS = 4_000;

function parseVersion(stdout: string): string | undefined {
  return /(\d+\.\d+\.\d+)/.exec(stdout)?.[1];
}

async function detectCli(command: string, args: string[]): Promise<RuntimeCli> {
  try {
    const result = await execa(command, args, { timeout: VERSION_TIMEOUT_MS, reject: false });
    const looksMissing =
      (result as { code?: string }).code === "ENOENT" ||
      result.exitCode === undefined ||
      /not recognized as an internal or external command/i.test(result.stderr ?? "");
    if (result.timedOut || looksMissing || result.failed || result.exitCode !== 0) {
      return { present: false };
    }
    const stdout = (result.stdout || result.stderr || "").trim();
    const version = parseVersion(stdout);
    return { present: true, ...(version !== undefined ? { version } : {}), detail: stdout };
  } catch {
    return { present: false };
  }
}

/** Is the `ollama` binary installed? (Server-up is a separate HTTP probe.) */
export function detectOllamaCli(command = "ollama"): Promise<RuntimeCli> {
  return detectCli(command, ["--version"]);
}

/** Is the Claude Code CLI installed? (Being logged in is a separate health check.) */
export function detectClaudeCli(command = "claude"): Promise<RuntimeCli> {
  return detectCli(command, ["--version"]);
}

/**
 * A PATH lookup on Windows often lands on an npm shim (`claude` /
 * `claude.cmd` in %APPDATA%\npm) rather than a real executable. Node ≥18
 * refuses to spawn .cmd files without a shell (CVE-2024-27980), so callers
 * that hand the path to a plain spawn need the underlying binary. The npm
 * package (@anthropic-ai/claude-code) ships it at a fixed spot next to the
 * shim; if that (or a plain sibling claude.exe) exists we prefer it, and
 * otherwise keep the shim path — some hosts CAN run it (shell spawns), and
 * validation below decides whether it actually works.
 */
function windowsCandidatesFor(found: string): string[] {
  if (!/\.(cmd|ps1)$/i.test(found) && /\.exe$/i.test(found)) return [found];
  const dir = dirname(found);
  const candidates = [
    join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"),
    join(dir, "claude.exe"),
  ].filter((p) => existsSync(p));
  candidates.push(found);
  return candidates;
}

/**
 * Absolute path to a Claude Code executable that actually runs, or undefined.
 * Looks up `claude` on PATH (`where` on win32, `which` elsewhere), resolves
 * npm shims to their real binary where possible, and only returns candidates
 * that answer `--version` with a version string. NEVER throws.
 */
export async function claudeExecutablePath(command = "claude"): Promise<string | undefined> {
  try {
    const lookup = process.platform === "win32" ? "where" : "which";
    const result = await execa(lookup, [command], {
      timeout: VERSION_TIMEOUT_MS,
      reject: false,
    });
    if (result.failed || result.exitCode !== 0 || !result.stdout) return undefined;
    const lines = result.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    // `where` returns every match; prefer a real .exe over shims.
    const ordered = [...lines].sort((a, b) => Number(/\.exe$/i.test(b)) - Number(/\.exe$/i.test(a)));
    const candidates =
      process.platform === "win32" ? ordered.flatMap(windowsCandidatesFor) : ordered;
    for (const candidate of [...new Set(candidates)]) {
      const check = await detectCli(candidate, ["--version"]);
      if (check.present && check.version !== undefined) return candidate;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
