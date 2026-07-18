import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { OnboardingWizard } from "../features/onboarding/OnboardingWizard";

/** Anyone can ask for the setup wizard (e.g. Settings → Re-run setup). */
export const OPEN_SETUP_EVENT = "embedded:open-setup";
export function openSetupWizard() {
  window.dispatchEvent(new Event(OPEN_SETUP_EVENT));
}

function NavItem({ to, label, glyph }: { to: string; label: string; glyph: ReactNode }) {
  return (
    <Link
      to={to}
      title={label}
      aria-label={label}
      className="ring-focus group relative flex h-10 w-10 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink-dim [&.active]:bg-surface-2 [&.active]:text-accent"
      activeOptions={{ exact: to === "/" }}
    >
      <span className="font-mono text-base">{glyph}</span>
      {/* label surfaces on hover — a slim rail stays quiet until asked */}
      <span className="pointer-events-none absolute left-full ml-2 hidden whitespace-nowrap rounded-md border border-line bg-surface-2 px-2 py-1 text-[11px] text-ink-dim shadow-lg shadow-black/40 group-hover:block">
        {label}
      </span>
    </Link>
  );
}

/** The setup wizard, shown once on a fresh install and on demand thereafter. */
function useSetupWizard() {
  const settings = useQuery({ queryKey: ["llm-settings"], queryFn: api.llm.getSettings });
  const [open, setOpen] = useState(false);
  const inited = useRef(false);

  // Auto-open exactly once, when we first learn the install hasn't been set up.
  useEffect(() => {
    if (!inited.current && settings.isSuccess) {
      inited.current = true;
      if (!settings.data.onboarded) setOpen(true);
    }
  }, [settings.isSuccess, settings.data]);

  // Let any surface re-open it later.
  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener(OPEN_SETUP_EVENT, handler);
    return () => window.removeEventListener(OPEN_SETUP_EVENT, handler);
  }, []);

  return { open, close: () => setOpen(false) };
}

/**
 * The frame. Everywhere but inside a project, a slim icon rail carries the
 * three spaces. On a project route the rail steps aside entirely — the project
 * brings its own phase rail — so the workspace gets its three clean panes. The
 * setup wizard overlays everything on first run.
 */
export function AppShell() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const inProject = /^\/projects\/[^/]+/.test(pathname);
  const wizard = useSetupWizard();

  const overlay = wizard.open ? <OnboardingWizard onFinish={wizard.close} /> : null;

  if (inProject) {
    return (
      <div className="h-full overflow-auto">
        <Outlet />
        {overlay}
      </div>
    );
  }

  return (
    <div className="flex h-full">
      <aside className="flex w-14 shrink-0 flex-col items-center gap-1 border-r border-line bg-surface-1 py-3">
        <Link to="/" title="embedded" className="ring-focus mb-4 flex h-10 w-10 items-center justify-center">
          <span className="font-mono text-lg font-semibold text-accent">e</span>
        </Link>
        <NavItem to="/" label="Projects" glyph="◧" />
        <NavItem to="/library" label="Library" glyph="⛁" />
        <NavItem to="/settings" label="Settings" glyph="⚙" />
      </aside>
      <main className="min-w-0 flex-1 overflow-auto">
        <Outlet />
      </main>
      {overlay}
    </div>
  );
}
