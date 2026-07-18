import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { createServer, connect, type Socket } from "node:net";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import extractZip from "extract-zip";

/**
 * Renode (MIT, Antmicro) is how this app runs firmware without hardware: a
 * full-system simulator with a built-in nRF52840 board model. It is NOT
 * bundled in the release zip — at ~112 MB it would triple it — but downloaded
 * on demand into the app's data dir, hash-verified, and reused forever after.
 *
 * Everything version-specific is pinned here, verified against a real
 * download and a real headless boot on Windows (2026-07-18): the portable
 * zip needs no installer, no admin rights, and no separate .NET runtime —
 * it carries its own.
 */
export const RENODE_VERSION = "1.16.1";
export const RENODE_ZIP_URL = `https://github.com/renode/renode/releases/download/v${RENODE_VERSION}/renode-${RENODE_VERSION}.windows-portable-dotnet.zip`;
/** Verified against GitHub's own asset digest — a mismatched download is refused, never used. */
export const RENODE_ZIP_SHA256 = "d09b7934cfd560cd06bde8f131ef78f521f10d423d5aac6096f2a583224aeb3e";
export const RENODE_ZIP_BYTES = 117_199_021;

export interface RenodeCapability {
  present: boolean;
  exePath?: string;
  version?: string;
  detail?: string;
}

/**
 * Case-insensitive filename walk for the simulator binary. The zip's internal
 * top-level folder name is an artifact of Antmicro's packaging, not a contract
 * — locating the exe by walking is what stays correct across versions.
 */
async function findFile(root: string, filename: string): Promise<string | undefined> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true, recursive: true });
  } catch {
    return undefined;
  }
  const lower = filename.toLowerCase();
  for (const entry of entries) {
    if (entry.isFile() && entry.name.toLowerCase() === lower) {
      return join(entry.parentPath, entry.name);
    }
  }
  return undefined;
}

/**
 * Is a previously-downloaded Renode present under `installDir`? Never throws;
 * `present: false` with a friendly detail is the normal answer on a machine
 * that has never simulated anything — same contract as `detectProbeRs`.
 * Presence means the binary exists on disk; it deliberately does not spawn
 * the exe, because Renode takes seconds to answer `--version` and this feeds
 * a UI gate that must stay fast.
 */
export async function detectRenode(installDir: string): Promise<RenodeCapability> {
  try {
    const exePath = await findFile(installDir, "renode.exe");
    if (exePath === undefined) {
      return {
        present: false,
        detail: `Renode not downloaded yet — one ~112 MB download, then simulation works offline`,
      };
    }
    return { present: true, exePath, version: RENODE_VERSION, detail: `Renode ${RENODE_VERSION} (portable)` };
  } catch {
    return { present: false, detail: "Renode not downloaded yet" };
  }
}

export interface EnsureRenodeOptions {
  installDir: string;
  /** injectable for tests — never download 112 MB in a unit test */
  fetchImpl?: typeof fetch;
  onProgress?: (p: { receivedBytes: number; totalBytes: number; phase: "download" | "extract" }) => void;
}

/** sha256 of a file, streamed — the zip does not fit in memory comfortably. */
async function sha256File(path: string): Promise<string> {
  const { createReadStream } = await import("node:fs");
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve())
      .on("error", reject);
  });
  return hash.digest("hex");
}

/**
 * Download-on-demand, idempotent. Already present and locatable → no network
 * at all. Otherwise: download to a temp name, verify the pinned SHA256 —
 * refusing a mismatch outright, because an unverifiable simulator binary is
 * worse than no simulator — then extract and locate the exe.
 */
export async function ensureRenode(opts: EnsureRenodeOptions): Promise<string> {
  const { installDir, onProgress } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;

  const already = await detectRenode(installDir);
  if (already.present && already.exePath !== undefined) return already.exePath;

  await mkdir(installDir, { recursive: true });
  const zipPath = join(installDir, `renode-${RENODE_VERSION}.zip.partial`);

  const res = await fetchImpl(RENODE_ZIP_URL, { signal: AbortSignal.timeout(15 * 60_000) });
  if (!res.ok || res.body === null) {
    throw new Error(`Renode download failed: HTTP ${res.status} from ${RENODE_ZIP_URL}`);
  }

  const out = createWriteStream(zipPath);
  let received = 0;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      onProgress?.({ receivedBytes: received, totalBytes: RENODE_ZIP_BYTES, phase: "download" });
      await new Promise<void>((resolve, reject) =>
        out.write(value, (err) => (err ? reject(err) : resolve())),
      );
    }
  } finally {
    await new Promise<void>((resolve) => out.end(() => resolve()));
  }

  const actual = await sha256File(zipPath);
  if (actual !== RENODE_ZIP_SHA256) {
    await rm(zipPath, { force: true });
    throw new Error(
      `Renode download hash mismatch: expected ${RENODE_ZIP_SHA256}, got ${actual} — refused, not extracted`,
    );
  }

  onProgress?.({ receivedBytes: received, totalBytes: RENODE_ZIP_BYTES, phase: "extract" });
  const finalZip = zipPath.replace(/\.partial$/, "");
  await rename(zipPath, finalZip);
  await extractZip(finalZip, { dir: installDir });
  await rm(finalZip, { force: true });

  const exePath = await findFile(installDir, "renode.exe");
  if (exePath === undefined) {
    throw new Error("Renode zip extracted but renode.exe was not found inside it");
  }
  return exePath;
}

/** ANSI escapes stripped — Renode colors its output even over a socket. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*m/g, "");
}

/**
 * True once a Monitor response buffer ends in a prompt. Renode's prompt is
 * `(monitor)` before a machine exists and `(machine-0)` etc. after — both are
 * a parenthesized word at the end of the stream.
 */
export function endsWithPrompt(buffer: string): boolean {
  return /\(\s*[\w-]+\s*\)\s*$/.test(stripAnsi(buffer).trimEnd());
}

/** A free TCP port, from the OS — racing for hardcoded ports breaks two parallel sessions. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      if (address === null || typeof address === "string") {
        srv.close();
        reject(new Error("could not allocate a port"));
        return;
      }
      const { port } = address;
      srv.close(() => resolve(port));
    });
  });
}

export interface RenodeSessionOptions {
  exePath: string;
  /** ms budget for the Monitor socket to start answering — a hang is not a wait */
  startTimeoutMs?: number;
}

export interface RenodeSession {
  /** run one Monitor command, resolved with its (ANSI-stripped) output */
  exec(command: string, timeoutMs?: number): Promise<string>;
  /**
   * Wire a UART to a socket terminal and stream everything the firmware
   * prints. Uses the mechanism verified live: CreateServerSocketTerminal +
   * connector Connect, then a second TCP connection.
   */
  attachUart(uartPath: string, onData: (chunk: string) => void): Promise<void>;
  /** e.g. queryState("sysbus.gpio0.led0") → "True" | "False" */
  queryState(peripheralPath: string): Promise<string>;
  close(): Promise<void>;
}

/**
 * Spawn headless Renode and drive its Monitor over TCP. `-P <port>` was
 * chosen over `--console` deliberately: console mode interleaves ANSI log
 * lines with the prompt on stdout and is unreliable to parse, while the
 * Monitor socket answers one command at a time. Verified against a real
 * nRF52840 boot.
 */
export async function startRenodeSession(opts: RenodeSessionOptions): Promise<RenodeSession> {
  const startTimeoutMs = opts.startTimeoutMs ?? 60_000;
  const monitorPort = await freePort();

  const child: ChildProcess = spawn(opts.exePath, ["--disable-xwt", "-P", String(monitorPort)], {
    stdio: "ignore",
    // no shell: the exe path is ours, and a shell would orphan the real
    // process behind cmd.exe, making kill() leak the simulator on Windows
    windowsHide: true,
  });

  const socket = await connectWithRetry(monitorPort, startTimeoutMs, child);
  const uartSockets: Socket[] = [];

  let buffer = "";
  let pending: { resolve: (s: string) => void; timer: NodeJS.Timeout } | undefined;
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    if (pending && endsWithPrompt(buffer)) {
      const { resolve, timer } = pending;
      pending = undefined;
      clearTimeout(timer);
      resolve(stripAnsi(buffer));
      buffer = "";
    }
  });

  const exec = (command: string, timeoutMs = 30_000): Promise<string> =>
    new Promise((resolve, reject) => {
      if (pending) {
        reject(new Error("a Monitor command is already in flight — Renode's Monitor is strictly one at a time"));
        return;
      }
      buffer = "";
      const timer = setTimeout(() => {
        pending = undefined;
        reject(new Error(`Renode Monitor did not answer "${command}" within ${timeoutMs} ms`));
      }, timeoutMs);
      pending = { resolve, timer };
      socket.write(`${command}\n`);
    });

  // swallow the greeting banner so the first real command starts clean
  await new Promise((r) => setTimeout(r, 300));
  buffer = "";

  return {
    exec,
    async attachUart(uartPath, onData) {
      const uartPort = await freePort();
      await exec(`emulation CreateServerSocketTerminal ${uartPort} "uart-term" false`);
      await exec(`connector Connect ${uartPath} uart-term`);
      const uartSocket = connect({ port: uartPort, host: "127.0.0.1" });
      uartSocket.on("data", (chunk) => onData(chunk.toString("utf8")));
      uartSockets.push(uartSocket);
    },
    async queryState(peripheralPath) {
      const out = await exec(`${peripheralPath} State`);
      return /True/.test(out) ? "True" : /False/.test(out) ? "False" : out.trim();
    },
    async close() {
      for (const s of uartSockets) s.destroy();
      try {
        // polite first: quit lets Renode delete its own temp files
        await exec("quit", 3_000);
      } catch {
        /* it may already be gone */
      }
      socket.destroy();
      if (child.exitCode === null) {
        child.kill();
        // taskkill fallback: on Windows a .NET host process can survive kill()
        setTimeout(() => {
          if (child.exitCode === null && child.pid !== undefined) {
            spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
          }
        }, 2_000).unref();
      }
    },
  };
}

async function connectWithRetry(port: number, budgetMs: number, child: ChildProcess): Promise<Socket> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`Renode exited with code ${child.exitCode} before its Monitor port opened`);
    }
    try {
      return await new Promise<Socket>((resolve, reject) => {
        const s = connect({ port, host: "127.0.0.1" });
        s.once("connect", () => resolve(s));
        s.once("error", reject);
      });
    } catch {
      if (Date.now() > deadline) {
        child.kill();
        throw new Error(`Renode's Monitor port did not open within ${budgetMs} ms`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

/** test seam */
export const __internals = { findFile, sha256File };
