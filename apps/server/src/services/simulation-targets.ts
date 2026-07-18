/**
 * The MCUs this app can simulate, and the toolchain identifiers each one needs.
 *
 * Why this table is allowed to exist at all, in a codebase whose governing rule
 * is "never guess a number nobody stated":
 *
 * `generatePlatformioIni` refuses to derive a `board =` from an MPN, and that
 * refusal is correct — an MPN names a CHIP, a PlatformIO board names a BOARD,
 * and the mapping is one-to-many (an nRF52840 sits on a DK, a Feather, a
 * Xiao, a custom panel, each with different pin mappings and a different
 * board id). Picking one silently would decide the user's pin mapping for
 * them. That is exactly the characteristic bug this project exists to avoid.
 *
 * This table is a different kind of claim. It does not say "your nRF52840 is
 * on a DK". It says "when this app SIMULATES an nRF52840, it simulates the
 * DK" — a statement about our own simulator, which is ours to make and which
 * we can state exactly. The board is not inferred from the design; it is a
 * property of the simulation harness, chosen here, written down, and shown to
 * the user in the UI rather than buried in generated output.
 *
 * The distinction that keeps this honest: a curated fact about our own tooling
 * is citable. An inferred fact about the user's hardware is not. So an MCU
 * absent from this table produces "simulation does not support this part yet",
 * never a nearest-match guess — the same shape of honest gap the rest of the
 * app emits when it does not know something.
 */

export interface SimulationTarget {
  /** Human-facing name of the simulated board. */
  boardName: string;
  /** PlatformIO `board =` id, used when building the user's own firmware. */
  platformioBoard: string;
  /**
   * PlatformIO `framework =`. Zephyr is chosen deliberately: it is what
   * Renode's own nRF52840 board model and reference scripts are built
   * against, so the firmware we build and the platform we run it on agree.
   * This is the app's stated choice, not a fact read off any datasheet.
   */
  platformioFramework: string;
  /** Renode platform description shipped inside the Renode distribution. */
  renodePlatform: string;
  /**
   * Peripheral path for the first user LED in Renode's device tree. Verified
   * against a real headless boot: it is `sysbus.gpio0.led0`, NOT `sysbus.led0`.
   */
  renodeLedPath: string;
  /** Renode peripheral the firmware's serial console is wired to. */
  renodeUartPath: string;
}

/**
 * Matched against a component MPN. Anchored at the start so `NRF52840-QIAA`
 * and `NRF52840` both match, while an unrelated part that merely CONTAINS the
 * string cannot.
 */
const TARGETS: Array<{ pattern: RegExp; target: SimulationTarget }> = [
  {
    pattern: /^NRF52840/i,
    target: {
      boardName: "nRF52840 DK",
      platformioBoard: "nrf52840_dk",
      platformioFramework: "zephyr",
      renodePlatform: "platforms/boards/nrf52840dk_nrf52840.repl",
      renodeLedPath: "sysbus.gpio0.led0",
      renodeUartPath: "sysbus.uart0",
    },
  },
];

/**
 * The simulation target for an MPN, or `undefined` when this app cannot
 * simulate that part. `undefined` is a normal, honest answer — callers must
 * surface it as "not supported yet" and must never substitute a near match.
 */
export function simulationTargetFor(mpn: string | undefined): SimulationTarget | undefined {
  if (mpn === undefined) return undefined;
  const trimmed = mpn.trim();
  return TARGETS.find(({ pattern }) => pattern.test(trimmed))?.target;
}

/** Every simulatable board, for the UI's "what is supported" answer. */
export function supportedSimulationBoards(): string[] {
  return TARGETS.map(({ target }) => target.boardName);
}
