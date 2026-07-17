import type { ComponentCategory, Lifecycle } from "@embedded/core";

export const CATEGORY_LABELS: Record<ComponentCategory, string> = {
  mcu: "MCU",
  sensor: "Sensor",
  radio: "Radio",
  power: "Power",
  "actuator-driver": "Actuator driver",
  display: "Display",
  memory: "Memory",
  connector: "Connector",
  passive: "Passive",
  discrete: "Discrete",
  other: "Other",
};

const LIFECYCLE_CLASS: Record<Lifecycle, string> = {
  active: "bg-ok/15 text-ok",
  nrnd: "bg-warn/15 text-warn",
  eol: "bg-danger/15 text-danger",
  obsolete: "bg-danger/15 text-danger",
  unknown: "bg-surface-3 text-ink-faint",
};

export function CategoryBadge({ category }: { category: ComponentCategory }) {
  return (
    <span className="rounded bg-surface-3 px-1.5 py-0.5 text-[11px] text-ink-dim">
      {CATEGORY_LABELS[category]}
    </span>
  );
}

export function LifecycleBadge({ lifecycle }: { lifecycle: Lifecycle }) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 font-mono text-[10px] uppercase ${LIFECYCLE_CLASS[lifecycle]}`}
    >
      {lifecycle}
    </span>
  );
}
