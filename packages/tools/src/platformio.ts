import { execa } from "execa";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * PlatformIO Core detection + build orchestration.
 *
 * Mirrors the house style set by probe-rs.ts: detection NEVER throws, because
 * `detectPlatformIO` feeds a UI gate — a thrown error here would take down a
 * page that has nothing to do with firmware builds. `present: false` is the
 * honest, ordinary answer on a machine that has never touched embedded
 * tooling, not an error state.
 *
 * PlatformIO Core is Apache-2.0 and fine to depend on, but it is an EXTERNAL
 * tool the user installs on their own machine — it is only ever spawned as a
 * subprocess here, never bundled or vendored into this repo.
 */

/**
 * What the host machine actually has for PlatformIO. "pio exists" is not the
 * same question as "pio can build an nRF52840 target" — the nordicnrf52
 * platform package is a separate, much larger install (a toolchain +
 * framework download), so it gets its own field rather than being folded
 * into `present`.
 */
export interface PlatformIoCapability {
  present: boolean;
  version?: string;
  detail?: string;
  /**
   * Whether the `nordicnrf52` platform package is installed. Always a real
   * boolean (never left undefined) — when `present` is false this is simply
   * `false`, because there is no pio to ask.
   */
  nordicNrf52Installed: boolean;
  nordicNrf52Detail?: string;
}

/** One chunk of build output as it streams off the `pio run` subprocess. */
export interface PlatformIoBuildProgress {
  stream: "stdout" | "stderr";
  chunk: string;
}

export interface PlatformIoBuildResult {
  /** Absolute path to the produced .elf, discovered under the build output dir. */
  elfPath: string;
  /** Full combined stdout+stderr log, in the order chunks arrived. */
  log: string;
}

/**
 * A PlatformIO build failure, carrying the compiler output that made it
 * fail. A bare "build failed" is useless to a user staring at a red button —
 * `log` is always the full output collected up to the point of failure.
 */
export class PlatformIoBuildError extends Error {
  readonly log: string;
  readonly timedOut: boolean;
  readonly exitCode?: number;

  constructor(message: string, opts: { log: string; exitCode?: number; timedOut?: boolean }) {
    super(message);
    this.name = "PlatformIoBuildError";
    this.log = opts.log;
    this.timedOut = opts.timedOut ?? false;
    if (opts.exitCode !== undefined) {
      this.exitCode = opts.exitCode;
    }
  }
}

const VERSION_TIMEOUT_MS = 5_000;
const PLATFORM_CHECK_TIMEOUT_MS = 15_000;
// Building is slow and a first build may install an entire toolchain +
// framework (nordicnrf52 alone is a few hundred MB). Fifteen minutes is
// generous but still bounded — this must never be allowed to hang forever.
const DEFAULT_BUILD_TIMEOUT_MS = 15 * 60 * 1_000;

/** Pull a bare version string ("6.1.15") out of PlatformIO's `--version` banner. */
function parseVersion(stdout: string): string | undefined {
  const match = /(\d+\.\d+\.\d+)/.exec(stdout);
  return match?.[1];
}

/**
 * A missing binary shows up differently by platform: POSIX spawn fails with
 * ENOENT and no exit code at all; Windows instead runs the lookup through
 * cmd.exe, which happily "succeeds" at spawning and reports back exit code 1
 * with "'foo' is not recognized ..." on stderr. Both are the same fact — the
 * binary isn't there.
 */
function looksMissing(result: { code?: string; exitCode?: number; stderr?: string }): boolean {
  return (
    result.code === "ENOENT" ||
    result.exitCode === undefined ||
    /not recognized as an internal or external command/i.test(result.stderr ?? "")
  );
}

/**
 * Is the `nordicnrf52` PlatformIO platform package installed? Only ever
 * called once `pio` itself is confirmed present. NEVER throws — folds every
 * failure into `installed: false` with a friendly detail, same contract as
 * the outer detector.
 */
async function checkNordicNrf52Platform(command: string): Promise<{ installed: boolean; detail?: string }> {
  try {
    const result = await execa(command, ["platform", "show", "nordicnrf52"], {
      timeout: PLATFORM_CHECK_TIMEOUT_MS,
      reject: false,
    });

    if (result.timedOut) {
      return {
        installed: false,
        detail: "checking the nordicnrf52 platform timed out — try `pio platform install nordicnrf52` manually",
      };
    }
    if (result.failed || result.exitCode !== 0) {
      return {
        installed: false,
        detail: "nordicnrf52 platform not installed — run `pio platform install nordicnrf52`",
      };
    }
    return { installed: true };
  } catch {
    return {
      installed: false,
      detail: "nordicnrf52 platform not installed — run `pio platform install nordicnrf52`",
    };
  }
}

/**
 * Detect whether PlatformIO Core is installed and runnable, and whether the
 * nordicnrf52 platform package (needed for any nRF52840 build) is installed.
 *
 * `command` is injectable (default `"pio"`) purely so tests can point this
 * at a binary name guaranteed not to exist, or at a stand-in like `node`,
 * and exercise both paths deterministically without depending on what the
 * test host happens to have installed.
 *
 * NEVER throws: every failure mode (missing binary, nonzero exit, timeout,
 * anything else) collapses to `present: false` with a friendly `detail`
 * string, because this feeds a UI gate.
 */
export async function detectPlatformIO(command = "pio"): Promise<PlatformIoCapability> {
  try {
    // `reject: false` turns a spawn failure (ENOENT), a nonzero exit, and a
    // timeout into a resolved result instead of a throw — the "not found"
    // path below is reached by inspecting the result, not by catching.
    const result = await execa(command, ["--version"], {
      timeout: VERSION_TIMEOUT_MS,
      reject: false,
    });

    if (result.timedOut) {
      return {
        present: false,
        nordicNrf52Installed: false,
        detail: "PlatformIO did not respond in time — install from platformio.org/install/cli",
      };
    }

    if (looksMissing(result as { code?: string; exitCode?: number; stderr?: string })) {
      return {
        present: false,
        nordicNrf52Installed: false,
        detail: "PlatformIO (pio) not found on PATH — install from platformio.org/install/cli",
      };
    }

    if (result.failed || result.exitCode !== 0) {
      return {
        present: false,
        nordicNrf52Installed: false,
        detail: "PlatformIO did not respond — install or reinstall from platformio.org/install/cli",
      };
    }

    const stdout = result.stdout.trim();
    const version = parseVersion(stdout);
    const platformCheck = await checkNordicNrf52Platform(command);

    return {
      present: true,
      ...(version !== undefined ? { version } : {}),
      detail: stdout,
      nordicNrf52Installed: platformCheck.installed,
      ...(platformCheck.detail !== undefined ? { nordicNrf52Detail: platformCheck.detail } : {}),
    };
  } catch {
    return {
      present: false,
      nordicNrf52Installed: false,
      detail: "PlatformIO (pio) not found on PATH — install from platformio.org/install/cli",
    };
  }
}

/**
 * Find the .elf produced by a PlatformIO build under `<projectDir>/.pio/build`.
 * PlatformIO nests build output one directory per env
 * (`.pio/build/<env>/firmware.elf`), and the env name comes from the
 * generated `platformio.ini` — so this walks the tree looking for the first
 * `.elf` rather than guessing a filename or env name.
 *
 * Returns undefined (never throws) when there is no build output yet, e.g.
 * `.pio` does not exist because the project has never been built.
 */
export async function findFirmwareElf(projectDir: string): Promise<string | undefined> {
  const buildDir = join(projectDir, ".pio", "build");
  let entries: string[];
  try {
    entries = await readdir(buildDir, { recursive: true });
  } catch {
    return undefined;
  }
  const elf = entries.find((entry) => entry.toLowerCase().endsWith(".elf"));
  return elf !== undefined ? join(buildDir, elf) : undefined;
}

export interface BuildFirmwareOptions {
  /** Injectable for tests — defaults to `"pio"`. */
  command?: string;
  /** Injectable for tests — defaults to `["run"]` (build the default env). */
  args?: string[];
  /** Called for every stdout/stderr chunk as the build streams out. */
  onProgress?: (progress: PlatformIoBuildProgress) => void;
  /** Bounded timeout in ms — defaults to 15 minutes to allow a first-run toolchain install. */
  timeoutMs?: number;
}

/**
 * Run a PlatformIO build in `projectDir` (a generated firmware project
 * directory containing `platformio.ini`, `src/`, etc.) and resolve with the
 * path to the produced `.elf` plus the full build log.
 *
 * Progress streams out via `onProgress` rather than blocking silently —
 * a first build can take minutes to install a toolchain, and a caller
 * driving a UI needs to show that something is happening.
 *
 * Rejects with a `PlatformIoBuildError` carrying the full compiler output on
 * any failure: nonzero exit, timeout, or a "successful" build that somehow
 * produced no .elf. Never rejects with a bare Error — the log is always
 * attached so a user (or the next agent) can see what actually went wrong.
 */
export async function buildFirmwareProject(
  projectDir: string,
  options: BuildFirmwareOptions = {},
): Promise<PlatformIoBuildResult> {
  const command = options.command ?? "pio";
  const args = options.args ?? ["run"];
  const timeoutMs = options.timeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS;

  let log = "";
  const collect = (stream: "stdout" | "stderr") => (data: Buffer | string) => {
    const text = data.toString();
    log += text;
    options.onProgress?.({ stream, chunk: text });
  };

  const subprocess = execa(command, args, {
    cwd: projectDir,
    timeout: timeoutMs,
    reject: false,
  });
  subprocess.stdout?.on("data", collect("stdout"));
  subprocess.stderr?.on("data", collect("stderr"));

  let result: Awaited<typeof subprocess>;
  try {
    result = await subprocess;
  } catch (err) {
    // Backstop only — `reject: false` above means this should not normally
    // be reached, but a build function must never throw a bare error either.
    throw new PlatformIoBuildError(
      err instanceof Error ? err.message : "PlatformIO build failed to start",
      { log },
    );
  }

  if (result.timedOut) {
    throw new PlatformIoBuildError("PlatformIO build timed out", { log, timedOut: true });
  }

  if (looksMissing(result as { code?: string; exitCode?: number; stderr?: string })) {
    throw new PlatformIoBuildError(
      "PlatformIO (pio) not found on PATH — install from platformio.org/install/cli",
      { log },
    );
  }

  if (result.failed || result.exitCode !== 0) {
    throw new PlatformIoBuildError(
      `PlatformIO build failed with exit code ${result.exitCode ?? "unknown"}`,
      { log, ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}) },
    );
  }

  const elfPath = await findFirmwareElf(projectDir);
  if (elfPath === undefined) {
    throw new PlatformIoBuildError(
      "PlatformIO reported a successful build but no .elf was found under .pio/build",
      { log, exitCode: result.exitCode },
    );
  }

  return { elfPath, log };
}
