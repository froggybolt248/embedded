import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RENODE_ZIP_SHA256,
  __internals,
  detectRenode,
  endsWithPrompt,
  ensureRenode,
  freePort,
  stripAnsi,
} from "./renode.js";

// Pure/offline tests only. The 112 MB download and a real simulator boot are
// exercised by using the app, not by unit tests — what CAN go quietly wrong
// (hash refusal, exe discovery, prompt detection) is what gets pinned here.

describe("detectRenode", () => {
  it("answers present:false with guidance on a machine that never downloaded it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "renode-detect-"));
    try {
      const cap = await detectRenode(dir);
      expect(cap.present).toBe(false);
      expect(cap.detail).toMatch(/download/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("finds renode.exe wherever the zip's internal folder layout put it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "renode-detect-"));
    try {
      // the top-level folder name is packaging trivia, not a contract
      const nested = join(dir, "renode_1.16.1-some-packaging-name", "bin");
      await mkdir(nested, { recursive: true });
      await writeFile(join(nested, "Renode.exe"), "not a real exe");
      const cap = await detectRenode(dir);
      expect(cap.present).toBe(true);
      expect(cap.exePath?.toLowerCase()).toContain("renode.exe");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("ensureRenode hash refusal", () => {
  it("refuses and deletes a download whose hash does not match the pin", async () => {
    const dir = await mkdtemp(join(tmpdir(), "renode-ensure-"));
    try {
      const fetchImpl = (async () =>
        new Response(new Blob([Buffer.from("definitely not the real zip")]), {
          status: 200,
        })) as unknown as typeof fetch;

      await expect(ensureRenode({ installDir: dir, fetchImpl })).rejects.toThrow(/hash mismatch.*refused/i);
      // nothing extractable may remain — a refused download must not be resumable into use
      const cap = await detectRenode(dir);
      expect(cap.present).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("is a no-op when the exe is already present — no network call at all", async () => {
    const dir = await mkdtemp(join(tmpdir(), "renode-ensure-"));
    try {
      await writeFile(join(dir, "renode.exe"), "already here");
      const fetchImpl = (async () => {
        throw new Error("network must not be touched");
      }) as unknown as typeof fetch;
      const exe = await ensureRenode({ installDir: dir, fetchImpl });
      expect(exe.toLowerCase()).toContain("renode.exe");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("monitor protocol helpers", () => {
  it("strips the ANSI color codes Renode emits even over a socket", () => {
    expect(stripAnsi("[1;32muart:~$ [m")).toBe("uart:~$ ");
  });

  it("recognizes both the bare monitor prompt and a machine prompt", () => {
    expect(endsWithPrompt("Renode, version 1.16.1\n(monitor) ")).toBe(true);
    expect(endsWithPrompt("True\n(machine-0) ")).toBe(true);
    expect(endsWithPrompt("still printing output")).toBe(false);
  });

  it("sha256 pin is well-formed", () => {
    expect(RENODE_ZIP_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("freePort", () => {
  it("hands out an OS-assigned port", async () => {
    const port = await freePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);
  });
});

describe("internals", () => {
  it("findFile returns undefined on a directory that does not exist, not a throw", async () => {
    expect(await __internals.findFile("Z:\\no\\such\\dir", "renode.exe")).toBeUndefined();
  });
});
