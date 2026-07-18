import { execa } from "execa";

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
