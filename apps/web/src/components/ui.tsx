import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from "react";

/**
 * Bench primitives — the design language of DESIGN.md, made reusable so no
 * surface re-types the class strings and drifts. Restrained by construction:
 * teal is spent only on the primary action, the current selection, and live
 * state; everything else is the neutral ramp.
 */

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/* ---- Panel: the section shell everything lives in ---------------------- */

export function Panel({
  children,
  className,
  as: Tag = "section",
}: {
  children: ReactNode;
  className?: string;
  as?: "section" | "div";
}) {
  return (
    <Tag className={cx("rounded-lg border border-line bg-surface-1", className)}>{children}</Tag>
  );
}

/** The labelled panel header — a functional label on a dense tool, not an eyebrow. */
export function PanelHeader({
  title,
  aside,
  icon,
}: {
  title: ReactNode;
  /** right-aligned metadata / summary, rendered in a calmer weight */
  aside?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line px-4 py-2.5">
      <h2 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
        {icon && <span className="text-ink-faint">{icon}</span>}
        {title}
      </h2>
      {aside && (
        <span className="text-[11px] font-normal normal-case tracking-normal text-ink-faint">
          {aside}
        </span>
      )}
    </div>
  );
}

/* ---- Button: primary is the only teal fill ----------------------------- */

type ButtonVariant = "primary" | "ghost" | "subtle" | "danger";
type ButtonSize = "sm" | "md";

const BTN_BASE =
  "ring-focus inline-flex items-center justify-center gap-1.5 rounded font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40";

const BTN_SIZE: Record<ButtonSize, string> = {
  sm: "px-2.5 py-1 text-[11px]",
  md: "px-3.5 py-1.5 text-xs",
};

const BTN_VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-accent text-surface-0 hover:bg-accent/90",
  ghost: "border border-line text-ink-dim hover:border-accent-dim hover:text-ink",
  subtle: "text-ink-faint hover:text-ink-dim",
  danger: "text-ink-faint hover:text-danger",
};

export function Button({
  variant = "ghost",
  size = "md",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  return (
    <button
      className={cx(BTN_BASE, BTN_SIZE[size], BTN_VARIANT[variant], className)}
      {...props}
    />
  );
}

/* ---- Form controls: native, styled, focus-visible ---------------------- */

const CONTROL =
  "ring-focus rounded border border-line bg-surface-2 text-ink outline-none transition-colors focus:border-accent-dim placeholder:text-ink-faint";

export function TextInput({
  className,
  mono,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }) {
  return (
    <input
      className={cx(CONTROL, "px-2.5 py-1.5 text-sm", mono && "num", className)}
      {...props}
    />
  );
}

export function Select({
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cx(CONTROL, "px-2 py-1.5 text-xs text-ink-dim", className)}
      {...props}
    >
      {children}
    </select>
  );
}

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cx("block", className)}>
      <span className="text-[11px] text-ink-faint">{label}</span>
      <div className="mt-1.5">{children}</div>
      {hint && <span className="mt-1 block text-[10px] text-ink-faint">{hint}</span>}
    </label>
  );
}

/* ---- Status: one 6px dot, semantic, optionally live -------------------- */

export type Tone = "ok" | "warn" | "danger" | "accent" | "neutral" | "muted";

const DOT_TONE: Record<Tone, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  danger: "bg-danger",
  accent: "bg-accent",
  neutral: "bg-surface-3",
  muted: "bg-ink-faint",
};

export function StatusDot({
  tone,
  pulse,
  className,
}: {
  tone: Tone;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cx(
        "inline-block h-1.5 w-1.5 shrink-0 rounded-full",
        DOT_TONE[tone],
        pulse && "animate-pulse",
        className,
      )}
    />
  );
}

/* ---- Readout: the one big instrument number of a panel ----------------- */

export function Readout({
  value,
  unit,
  label,
  align = "left",
}: {
  value: ReactNode;
  unit?: ReactNode;
  label?: ReactNode;
  align?: "left" | "right";
}) {
  return (
    <div className={align === "right" ? "text-right" : undefined}>
      <div className="num text-2xl font-semibold leading-none text-ink">
        {value}
        {unit && <span className="ml-1 text-base font-normal text-ink-dim">{unit}</span>}
      </div>
      {label && <div className="mt-1.5 text-[11px] text-ink-faint">{label}</div>}
    </div>
  );
}

/* ---- Ring: SVG completeness arc (phase rail) --------------------------- */

const RING_TONE: Record<Tone, string> = {
  ok: "var(--color-ok)",
  warn: "var(--color-warn)",
  danger: "var(--color-danger)",
  accent: "var(--color-accent)",
  neutral: "var(--color-ink-faint)",
  muted: "var(--color-ink-faint)",
};

/**
 * A completeness ring, 0..1. `tone` colors the filled arc; the track is always
 * the faint line color. Center content (a glyph, an index) is optional.
 */
export function Ring({
  value,
  tone = "accent",
  size = 22,
  stroke = 2.5,
  children,
}: {
  value: number;
  tone?: Tone;
  size?: number;
  stroke?: number;
  children?: ReactNode;
}) {
  const clamped = Math.max(0, Math.min(1, value));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <span className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-line)" strokeWidth={stroke} />
        {clamped > 0 && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={RING_TONE[tone]}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={c * (1 - clamped)}
            style={{ transition: "stroke-dashoffset var(--dur) var(--ease-out)" }}
          />
        )}
      </svg>
      {children && (
        <span className="absolute inset-0 flex items-center justify-center text-[9px] text-ink-faint">
          {children}
        </span>
      )}
    </span>
  );
}

/* ---- EmptyState: teach the surface, never "nothing here" --------------- */

export function EmptyState({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <p className={cx("px-4 py-6 text-center text-xs leading-relaxed text-ink-faint", className)}>
      {children}
    </p>
  );
}

/* ---- Spinner: a quiet in-flight tick ----------------------------------- */

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cx(
        "inline-block h-3 w-3 animate-spin rounded-full border border-line border-t-accent",
        className,
      )}
    />
  );
}
