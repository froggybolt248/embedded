import { execa } from "execa";

/**
 * What the host machine actually has, for one optional external CLI.
 *
 * `present: false` is not an error state — it is the normal, honest answer on
 * a machine that has never touched embedded tooling. The whole point of this
 * detector is that callers can trust `present` without a fallback branch: it
 * is only ever true when the binary really ran and answered, never assumed
 * from e.g. a config flag or a cached "probably installed".
 */
export interface ProbeRsCapability {
  present: boolean;
  version?: string;
  detail?: string;
}

const VERSION_TIMEOUT_MS = 3_000;

/** Pull a bare version string ("0.24.0") out of probe-rs's `--version` banner. */
function parseVersion(stdout: string): string | undefined {
  const match = /(\d+\.\d+\.\d+)/.exec(stdout);
  return match?.[1];
}

/**
 * Detect whether `probe-rs` is installed and runnable.
 *
 * `command` is injectable (default `"probe-rs"`) purely so tests can point
 * this at a binary name that is guaranteed not to exist and exercise the
 * not-found path deterministically, without depending on what the test host
 * happens to have on PATH.
 *
 * NEVER throws: every failure mode (missing binary, nonzero exit, timeout,
 * anything else) collapses to `present: false` with a friendly `detail`
 * string, because this feeds a UI gate — a thrown error here would take down
 * a page that has nothing to do with flashing.
 */
export async function detectProbeRs(command = "probe-rs"): Promise<ProbeRsCapability> {
  try {
    // `reject: false` turns a spawn failure (ENOENT), a nonzero exit, and a
    // timeout into a resolved result instead of a throw — so the "not found"
    // path below is reached by inspecting the result, not by catching. The
    // try/catch that wraps this is only a backstop for anything execa itself
    // throws synchronously; this function must NEVER throw.
    const result = await execa(command, ["--version"], {
      timeout: VERSION_TIMEOUT_MS,
      reject: false,
    });

    if (result.timedOut) {
      return {
        present: false,
        detail: "probe-rs did not respond in time — install or reinstall from probe.rs",
      };
    }

    // A missing binary shows up differently by platform: POSIX spawn fails
    // with ENOENT and no exit code at all; Windows instead runs the lookup
    // through cmd.exe, which happily "succeeds" at spawning and reports back
    // exit code 1 with "'foo' is not recognized ..." on stderr. Both are the
    // same fact — the binary isn't there — so both get the same message.
    const looksMissing =
      (result as { code?: string }).code === "ENOENT" ||
      result.exitCode === undefined ||
      /not recognized as an internal or external command/i.test(result.stderr ?? "");
    if (looksMissing) {
      return {
        present: false,
        detail: "probe-rs not found on PATH — install from probe.rs",
      };
    }

    if (result.failed || result.exitCode !== 0) {
      return {
        present: false,
        detail: "probe-rs did not respond — install or reinstall from probe.rs",
      };
    }

    const stdout = result.stdout.trim();
    const version = parseVersion(stdout);
    return {
      present: true,
      ...(version !== undefined ? { version } : {}),
      detail: stdout,
    };
  } catch {
    return {
      present: false,
      detail: "probe-rs not found on PATH — install from probe.rs",
    };
  }
}
