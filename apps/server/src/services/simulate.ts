import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { appDataDir } from "@embedded/db";
import type { Component } from "@embedded/core";
import type { Block, Connection } from "@embedded/core";
import { generatePinmapHeader, generatePlatformioIni } from "./firmware.js";
import type { SimulationTarget } from "./simulation-targets.js";

/** Where the on-demand simulator lives — survives app updates, downloaded once. */
export function renodeInstallDir(): string {
  return join(appDataDir(), "tools", "renode");
}

/** Per-project simulation workspace: the materialized firmware project. */
export function simWorkspaceDir(projectId: string): string {
  return join(appDataDir(), "sim", projectId);
}

/**
 * The harness's own smoke firmware: boot, print a heartbeat on the console
 * UART, blink the first LED. Deliberately does NOT include pins.h — this
 * firmware exists to prove the board model boots and the app can see UART
 * and GPIO, before the user's own code exists. It runs even on a design
 * whose pins are still unassigned, because proving the simulator works must
 * not wait for decisions the simulator does not need.
 */
function smokeMainC(projectName: string): string {
  return [
    `/* ${projectName} — simulation smoke firmware (generated) */`,
    `#include <zephyr/kernel.h>`,
    `#include <zephyr/drivers/gpio.h>`,
    ``,
    `static const struct gpio_dt_spec led = GPIO_DT_SPEC_GET(DT_ALIAS(led0), gpios);`,
    ``,
    `int main(void)`,
    `{`,
    `\tint n = 0;`,
    `\tgpio_pin_configure_dt(&led, GPIO_OUTPUT_ACTIVE);`,
    `\twhile (1) {`,
    `\t\tgpio_pin_toggle_dt(&led);`,
    `\t\tprintk("embedded-sim heartbeat %d\\n", n++);`,
    `\t\tk_msleep(500);`,
    `\t}`,
    `\treturn 0;`,
    `}`,
    ``,
  ].join("\n");
}

export interface MaterializeInput {
  projectId: string;
  projectName: string;
  blocks: Block[];
  connections: Connection[];
  components: Map<string, Component>;
}

/**
 * Write the generated firmware project to disk as a buildable PlatformIO
 * tree. The same generators the Firmware phase serves as text become real
 * files here — one source of truth, two consumers. pins.h goes to include/
 * for the user's own code to pick up; the smoke main.c does not include it
 * (see above).
 */
export async function materializeSimProject(input: MaterializeInput): Promise<string> {
  const dir = simWorkspaceDir(input.projectId);
  await mkdir(join(dir, "src"), { recursive: true });
  await mkdir(join(dir, "include"), { recursive: true });
  await mkdir(join(dir, "zephyr"), { recursive: true });

  const genInput = {
    projectName: input.projectName,
    blocks: input.blocks,
    connections: input.connections,
    components: input.components,
  };
  await writeFile(join(dir, "platformio.ini"), generatePlatformioIni(genInput), "utf8");
  await writeFile(join(dir, "include", "pins.h"), generatePinmapHeader(genInput), "utf8");
  await writeFile(join(dir, "src", "main.c"), smokeMainC(input.projectName), "utf8");
  await writeFile(join(dir, "zephyr", "prj.conf"), "CONFIG_GPIO=y\n", "utf8");
  return dir;
}

/** Renode's `@` paths want forward slashes, even on Windows. */
export function renodePath(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * The Monitor commands that boot a target with a given ELF. Kept as data so
 * the run route streams exactly what it executed — a simulation transcript a
 * user can replay by hand in Renode is auditable; a black box is not.
 */
export function bootCommands(target: SimulationTarget, elfPath: string): string[] {
  return [
    "mach create",
    `machine LoadPlatformDescription @${target.renodePlatform}`,
    `sysbus LoadELF @${renodePath(elfPath)}`,
    "start",
  ];
}
