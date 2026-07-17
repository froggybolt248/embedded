import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";

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

/**
 * The frame. Everywhere but inside a project, a slim icon rail carries the
 * three spaces. On a project route the rail steps aside entirely — the project
 * brings its own phase rail — so the workspace gets its three clean panes.
 */
export function AppShell() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const inProject = /^\/projects\/[^/]+/.test(pathname);

  if (inProject) {
    return (
      <div className="h-full overflow-auto">
        <Outlet />
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
    </div>
  );
}
