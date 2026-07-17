import { Link } from "@tanstack/react-router";

const tabClass =
  "rounded-md px-3 py-1.5 text-sm text-ink-dim transition-colors hover:bg-surface-2 hover:text-ink [&.active]:bg-surface-2 [&.active]:text-accent";

export function LibraryTabs() {
  return (
    <nav className="mb-6 flex gap-1 border-b border-line pb-3">
      <Link to="/library" className={tabClass} activeOptions={{ exact: true }}>
        Components
      </Link>
      <Link to="/library/datasheets" className={tabClass}>
        Datasheets
      </Link>
      <Link to="/library/sources" className={tabClass}>
        Sources
      </Link>
    </nav>
  );
}
