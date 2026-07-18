import os from "node:os";
import { execa } from "execa";

/**
 * What the host machine can bring to running a local model. This exists to
 * answer one question for onboarding: "if you go local, which model actually
 * fits here?" — so the numbers are the ones that decide that (usable memory and
 * whether there's a GPU the runner can use), not an exhaustive inventory.
 *
 * Like the CLI detectors, this NEVER throws: every probe collapses to a best
 * guess, because it feeds a setup screen, not a load-bearing code path.
 */
export type Accelerator = "cuda" | "metal" | "cpu";

export interface GpuInfo {
  name: string;
  /** total dedicated VRAM in GB, when we could read it accurately; else undefined */
  vramGb?: number;
  vendor: "nvidia" | "amd" | "intel" | "apple" | "other";
}

export interface HardwareInfo {
  cpu: { model: string; cores: number };
  ramGb: number;
  gpus: GpuInfo[];
  /** the runner path we expect Ollama to take on this box */
  accelerator: Accelerator;
  /**
   * Memory the recommendation should size a model against, in GB. For a CUDA
   * box this is the biggest NVIDIA card's VRAM; for Apple it's a slice of
   * unified memory; on CPU it's system RAM. This is the one number the model
   * picker reads.
   */
  budgetGb: number;
}

const PROBE_TIMEOUT_MS = 4_000;

function gbFromBytes(bytes: number): number {
  return Math.round((bytes / 1024 ** 3) * 10) / 10;
}

/**
 * NVIDIA VRAM straight from the driver — the only reliable cross-platform
 * source. `Win32_VideoController.AdapterRAM` is a uint32 that saturates at 4 GB
 * and under-reports every modern card, so we never trust it for VRAM.
 */
async function nvidiaGpus(): Promise<GpuInfo[]> {
  try {
    const res = await execa(
      "nvidia-smi",
      ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
      { timeout: PROBE_TIMEOUT_MS, reject: false },
    );
    if (res.failed || res.exitCode !== 0 || !res.stdout) return [];
    return res.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [name, mib] = line.split(",").map((s) => s.trim());
        const gpu: GpuInfo = { name: name ?? "NVIDIA GPU", vendor: "nvidia" };
        const mibNum = Number(mib);
        if (Number.isFinite(mibNum) && mibNum > 0) gpu.vramGb = Math.round(mibNum / 1024);
        return gpu;
      });
  } catch {
    return [];
  }
}

/**
 * Every display adapter and its true VRAM from the Windows driver registry
 * (`HardwareInformation.qwMemorySize` — a 64-bit value, unlike AdapterRAM). Used
 * to see non-NVIDIA GPUs and as the NVIDIA fallback when nvidia-smi is absent.
 */
async function windowsGpus(): Promise<GpuInfo[]> {
  if (process.platform !== "win32") return [];
  const script =
    "Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\*' " +
    "-ErrorAction SilentlyContinue | Where-Object { $_.'HardwareInformation.qwMemorySize' } | " +
    "ForEach-Object { $_.DriverDesc + '|' + $_.'HardwareInformation.qwMemorySize' }";
  try {
    const res = await execa("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
      timeout: PROBE_TIMEOUT_MS,
      reject: false,
    });
    // Trust stdout, not the exit code: the wildcard registry read trips a
    // non-terminating error on class subkeys that lack the property, so
    // PowerShell exits 1 even when it printed every adapter correctly.
    if (res.timedOut || !res.stdout) return [];
    return res.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [name = "GPU", bytes] = line.split("|");
        const gpu: GpuInfo = { name, vendor: vendorOf(name) };
        const b = Number(bytes);
        if (Number.isFinite(b) && b > 0) gpu.vramGb = gbFromBytes(b);
        return gpu;
      });
  } catch {
    return [];
  }
}

function vendorOf(name: string): GpuInfo["vendor"] {
  const n = name.toLowerCase();
  if (n.includes("nvidia") || n.includes("geforce") || n.includes("rtx") || n.includes("quadro"))
    return "nvidia";
  if (n.includes("amd") || n.includes("radeon")) return "amd";
  if (n.includes("intel") || n.includes("arc")) return "intel";
  if (n.includes("apple")) return "apple";
  return "other";
}

/** Merge nvidia-smi (authoritative VRAM) with the registry sweep (all adapters). */
function mergeGpus(nvidia: GpuInfo[], others: GpuInfo[]): GpuInfo[] {
  const merged: GpuInfo[] = [...nvidia];
  for (const g of others) {
    if (g.vendor === "nvidia" && nvidia.length > 0) continue; // nvidia-smi already, and accurate
    merged.push(g);
  }
  return merged;
}

export async function detectHardware(): Promise<HardwareInfo> {
  const cpus = os.cpus();
  const cpu = { model: (cpus[0]?.model ?? "CPU").trim(), cores: cpus.length || 1 };
  const ramGb = gbFromBytes(os.totalmem());

  const [nvidia, others] = await Promise.all([nvidiaGpus(), windowsGpus()]);
  const gpus = mergeGpus(nvidia, others);

  // Only paths Ollama actually accelerates on are treated as GPU budgets. A big
  // NVIDIA card decides everything; Apple silicon shares memory with the CPU;
  // everything else (integrated, unsupported) is honestly a CPU run.
  const bestNvidia = gpus
    .filter((g) => g.vendor === "nvidia" && (g.vramGb ?? 0) >= 4)
    .sort((a, b) => (b.vramGb ?? 0) - (a.vramGb ?? 0))[0];

  let accelerator: Accelerator;
  let budgetGb: number;
  if (bestNvidia) {
    accelerator = "cuda";
    budgetGb = bestNvidia.vramGb ?? 8;
  } else if (process.platform === "darwin") {
    accelerator = "metal";
    // unified memory: leave headroom for the OS and everything else
    budgetGb = Math.max(4, Math.round(ramGb * 0.6));
  } else {
    accelerator = "cpu";
    budgetGb = ramGb;
  }

  return { cpu, ramGb, gpus, accelerator, budgetGb };
}
