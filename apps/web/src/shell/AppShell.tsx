import { Link, Outlet } from "@tanstack/react-router";
import type { ReactNode } from "react";

function NavItem({ to, label, glyph }: { to: string; label: string; glyph: ReactNode }) {
  return (
    <Link
      to={to}
      className="flex items-center gap-3 rounded-md px-3 py-2 text-sm text-ink-dim hover:bg-surface-2 hover:text-ink transition-colors [&.active]:bg-surface-2 [&.active]:text-accent"
      activeOptions={{ exact: to === "/" }}
    >
      <span className="w-4 text-center font-mono">{glyph}</span>
      {label}
    </Link>
  );
}

export function AppShell() {
  return (
    <div className="flex h-full">
      <aside className="flex w-52 shrink-0 flex-col border-r border-line bg-surface-1 p-3">
        <div className="mb-6 flex items-baseline gap-2 px-3 pt-2">
          <span className="font-mono text-lg font-semibold tracking-tight text-accent">
            embedded
          </span>
          <span className="font-mono text-[10px] text-ink-faint">v0.1</span>
        </div>
        <nav className="flex flex-col gap-1">
          <NavItem to="/" label="Projects" glyph="◧" />
          <NavItem to="/library" label="Library" glyph="⛁" />
          <NavItem to="/settings" label="Settings" glyph="⚙" />
        </nav>
        <div className="mt-auto px-3 pb-1 font-mono text-[10px] text-ink-faint">
          local · all data yours
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
