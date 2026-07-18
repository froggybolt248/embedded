import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectPlatformIO,
  findFirmwareElf,
  buildFirmwareProject,
  PlatformIoBuildError,
} from "./platformio.js";

const MISSING = "embedded-definitely-not-a-real-binary";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pio-test-"));
}

describe("detectPlatformIO", () => {
  it("reports present:false with a friendly detail when the binary does not exist", async () => {
    const result = await detectPlatformIO(MISSING);
    expect(result.present).toBe(false);
    expect(result.version).toBeUndefined();
    expect(result.nordicNrf52Installed).toBe(false);
    expect(result.detail).toMatch(/PlatformIO \(pio\) not found on PATH/);
  });

  it("never throws, even when the command cannot be spawned", async () => {
    await expect(detectPlatformIO(MISSING)).resolves.toBeDefined();
  });

  it("reports present:true with a parsed version when the command succeeds, and honestly reports the platform as not installed", async () => {
    // Node itself stands in for a well-behaved CLI: `node --version` exits 0
    // and prints a version-shaped string, matching what `pio --version`
    // produces. The follow-up `node platform show nordicnrf52` call fails
    // (node has no such subcommand), which exercises the "pio exists but
    // the platform package doesn't" path honestly.
    const result = await detectPlatformIO("node");
    expect(result.present).toBe(true);
    expect(result.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(result.nordicNrf52Installed).toBe(false);
    expect(result.nordicNrf52Detail).toMatch(/nordicnrf52 platform not installed/);
  });
});

describe("findFirmwareElf", () => {
  it("returns undefined when there is no .pio/build directory at all", async () => {
    const dir = await makeTempDir();
    try {
      expect(await findFirmwareElf(dir)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("finds an .elf nested under .pio/build/<env>/", async () => {
    const dir = await makeTempDir();
    try {
      const envDir = join(dir, ".pio", "build", "nrf52840_dk");
      await mkdir(envDir, { recursive: true });
      await writeFile(join(envDir, "other.map"), "not the elf");
      await writeFile(join(envDir, "firmware.elf"), "fake elf bytes");

      const found = await findFirmwareElf(dir);
      expect(found).toBe(join(envDir, "firmware.elf"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not depend on a hardcoded filename", async () => {
    const dir = await makeTempDir();
    try {
      const envDir = join(dir, ".pio", "build", "some-other-env-name");
      await mkdir(envDir, { recursive: true });
      await writeFile(join(envDir, "weirdly-named-output.elf"), "fake elf bytes");

      const found = await findFirmwareElf(dir);
      expect(found).toBe(join(envDir, "weirdly-named-output.elf"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("buildFirmwareProject", () => {
  it("streams progress and resolves with the discovered .elf on success", async () => {
    const dir = await makeTempDir();
    try {
      // Simulate PlatformIO having produced output before this ran (a real
      // `pio run` writes into .pio/build itself; here we pre-seed it since
      // the stand-in "build" command below is just `node` printing text).
      const envDir = join(dir, ".pio", "build", "nrf52840_dk");
      await mkdir(envDir, { recursive: true });
      await writeFile(join(envDir, "firmware.elf"), "fake elf bytes");

      const chunks: string[] = [];
      const result = await buildFirmwareProject(dir, {
        command: "node",
        args: ["-e", "process.stdout.write('Building...\\n'); process.stderr.write('warn: ok\\n');"],
        onProgress: (p) => chunks.push(`${p.stream}:${p.chunk}`),
      });

      expect(result.elfPath).toBe(join(envDir, "firmware.elf"));
      expect(result.log).toMatch(/Building/);
      expect(result.log).toMatch(/warn: ok/);
      expect(chunks.length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects with a PlatformIoBuildError carrying the compiler output on a nonzero exit", async () => {
    const dir = await makeTempDir();
    try {
      await expect(
        buildFirmwareProject(dir, {
          command: "node",
          args: ["-e", "process.stderr.write('error: undefined reference to foo\\n'); process.exit(1);"],
        }),
      ).rejects.toMatchObject({
        name: "PlatformIoBuildError",
        exitCode: 1,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("includes the collected log on failure, not just a bare message", async () => {
    const dir = await makeTempDir();
    try {
      let caught: unknown;
      try {
        await buildFirmwareProject(dir, {
          command: "node",
          args: ["-e", "process.stderr.write('error: something specific broke\\n'); process.exit(2);"],
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(PlatformIoBuildError);
      expect((caught as PlatformIoBuildError).log).toMatch(/something specific broke/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects with a structured error (never a bare success) when the build exits 0 but produces no .elf", async () => {
    const dir = await makeTempDir();
    try {
      await expect(
        buildFirmwareProject(dir, {
          command: "node",
          args: ["-e", "process.stdout.write('done, but nothing built\\n');"],
        }),
      ).rejects.toMatchObject({
        name: "PlatformIoBuildError",
        message: expect.stringMatching(/no \.elf was found/),
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects with timedOut:true when the build exceeds the bounded timeout", async () => {
    const dir = await makeTempDir();
    try {
      let caught: unknown;
      try {
        await buildFirmwareProject(dir, {
          command: "node",
          args: ["-e", "setTimeout(() => {}, 10_000);"],
          timeoutMs: 200,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(PlatformIoBuildError);
      expect((caught as PlatformIoBuildError).timedOut).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
