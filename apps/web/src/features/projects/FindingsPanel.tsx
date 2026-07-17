import { useQuery } from "@tanstack/react-query";
import type { Finding } from "@embedded/core";
import { api } from "../../lib/api";

const SEVERITY_ORDER: Record<Finding["severity"], number> = { error: 0, warning: 1, info: 2 };

const SEVERITY_CLASS: Record<Finding["severity"], string> = {
  error: "text-danger",
  warning: "text-warn",
  info: "text-ink-faint",
};

/** sort key: failed (by severity) < needs-input < broken */
function sortKey(f: Finding): number {
  if (f.status === "failed") return SEVERITY_ORDER[f.severity];
  if (f.status === "needs-input") return 10;
  return 20; // broken
}

/**
 * The Electrical phase's output — what the rules found, or didn't find because
 * they couldn't run. `status` is the whole point of this panel: a `failed`
 * finding is a real problem, a `needs-input` finding is a question the design
 * hasn't answered yet, and a `broken` one is a bug in a rule, not in the
 * design. Collapsing any two of those into the same look would lie about
 * which one happened — see the comment on `FindingStatus` in
 * `packages/core/src/knowledge.ts`.
 *
 * Thin presentation only: it renders what the server computed, verbatim.
 */
export function FindingsPanel({ projectId }: { projectId: string }) {
  const { data: findings, isLoading } = useQuery({
    queryKey: ["findings", projectId],
    queryFn: () => api.findings.list(projectId),
  });

  const failed = (findings ?? []).filter((f) => f.status === "failed");
  const needsInput = (findings ?? []).filter((f) => f.status === "needs-input");
  const broken = (findings ?? []).filter((f) => f.status === "broken");
  const problems = failed.filter((f) => f.severity === "error" || f.severity === "warning").length;

  const summaryParts: string[] = [];
  if (problems > 0) summaryParts.push(`${problems} problem${problems === 1 ? "" : "s"}`);
  if (needsInput.length > 0) summaryParts.push(`${needsInput.length} need${needsInput.length === 1 ? "s" : ""} input`);
  const summary = summaryParts.join(" · ");

  const sorted = [...(findings ?? [])].sort((a, b) => sortKey(a) - sortKey(b));

  return (
    <section className="rounded-lg border border-line bg-surface-1">
      <h2 className="flex items-baseline justify-between border-b border-line px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
        <span>Findings</span>
        {summary && (
          <span className="font-normal normal-case tracking-normal text-ink-faint">{summary}</span>
        )}
      </h2>

      {isLoading && (
        <div className="px-4 py-6 text-center text-xs text-ink-faint">Loading findings…</div>
      )}

      {findings && findings.length === 0 && (
        <p className="px-4 py-6 text-center text-xs text-ink-faint">
          Nothing to flag yet — bind parts and wire them up, and the checks run automatically.
        </p>
      )}

      {findings && findings.length > 0 && (
        <ul>
          {sorted.map((f, i) => (
            <FindingRow key={`${f.ruleId}-${f.subject.id}-${i}`} finding={f} />
          ))}
        </ul>
      )}
    </section>
  );
}

function FindingRow({ finding }: { finding: Finding }) {
  if (finding.status === "needs-input") {
    return (
      <li className="border-b border-line/60 px-4 py-2.5 last:border-b-0">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-xs text-ink-dim">{finding.subject.label}</span>
          <span className="text-[10px] uppercase tracking-wide text-ink-faint">
            {finding.ruleName}
          </span>
        </div>
        <p className="mt-0.5 text-[11px] text-ink-faint">
          needs: {finding.missingInputs.join(", ")}
        </p>
      </li>
    );
  }

  if (finding.status === "broken") {
    return (
      <li className="border-b border-line/60 px-4 py-2.5 last:border-b-0">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-xs text-ink-dim">{finding.subject.label}</span>
          <span className="text-[10px] uppercase tracking-wide text-ink-faint">
            {finding.ruleName}
          </span>
        </div>
        <p className="mt-0.5 text-[11px] text-danger/70">
          This rule is broken and could not run — the design was not checked against it.
        </p>
      </li>
    );
  }

  // status === "failed"
  return (
    <li className="border-b border-line/60 px-4 py-2.5 last:border-b-0">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs text-ink-dim">{finding.subject.label}</span>
        <span className="text-[10px] uppercase tracking-wide text-ink-faint">
          {finding.ruleName}
        </span>
      </div>
      <p className={`mt-0.5 text-[11px] ${SEVERITY_CLASS[finding.severity]}`}>{finding.message}</p>
      {finding.citation && (
        <p className="mt-0.5 text-[10px] text-ink-faint">{finding.citation}</p>
      )}
    </li>
  );
}
