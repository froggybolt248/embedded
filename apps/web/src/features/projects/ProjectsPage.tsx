import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { api } from "../../lib/api";

export function ProjectsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: projects, isLoading } = useQuery({
    queryKey: ["projects"],
    queryFn: api.projects.list,
  });
  const { data: archetypes } = useQuery({
    queryKey: ["archetypes"],
    queryFn: api.archetypes.list,
  });

  const [name, setName] = useState("");
  const [archetypeId, setArchetypeId] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.projects.create({
        name: name.trim(),
        ...(archetypeId !== null ? { archetypeId } : {}),
      }),
    onSuccess: (project) => {
      setName("");
      setArchetypeId(null);
      qc.invalidateQueries({ queryKey: ["projects"] });
      // straight into the build — the architecture is already sketched
      navigate({ to: "/projects/$projectId", params: { projectId: project.id } });
    },
  });
  const remove = useMutation({
    mutationFn: api.projects.remove,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });

  const chosen = archetypes?.find((a) => a.id === archetypeId);

  return (
    <div className="mx-auto max-w-3xl p-8">
      <h1 className="mb-1 text-xl font-semibold">Projects</h1>
      <p className="mb-6 text-sm text-ink-dim">
        Start from something like what you're building. The architecture arrives sketched, and the
        electrical numbers follow from the parts you pick.
      </p>

      <form
        className="mb-8 rounded-lg border border-line bg-surface-1 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate();
        }}
      >
        <p className="mb-2 text-[11px] uppercase tracking-wide text-ink-faint">
          What are you building?
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          {archetypes?.map((a) => {
            const active = archetypeId === a.id;
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => setArchetypeId(active ? null : a.id)}
                className={`rounded-md border p-3 text-left transition-colors ${
                  active
                    ? "border-accent bg-surface-2"
                    : "border-line hover:border-accent-dim hover:bg-surface-2"
                }`}
              >
                <div className="text-sm font-medium text-ink">{a.name}</div>
                <div className="mt-1 line-clamp-3 text-[11px] leading-relaxed text-ink-faint">
                  {a.description}
                </div>
                <div className="num mt-2 text-[10px] text-ink-faint">
                  {a.recipe.suggestedBlocks.length} blocks
                  {a.recipe.powerTarget?.batteryLabel
                    ? ` · ${a.recipe.powerTarget.batteryLabel}`
                    : ""}
                </div>
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setArchetypeId(null)}
            className={`rounded-md border border-dashed p-3 text-left transition-colors ${
              archetypeId === null
                ? "border-accent bg-surface-2"
                : "border-line hover:border-accent-dim"
            }`}
          >
            <div className="text-sm font-medium text-ink-dim">Something else</div>
            <div className="mt-1 text-[11px] leading-relaxed text-ink-faint">
              Start from an empty canvas and add blocks yourself.
            </div>
          </button>
        </div>

        <div className="mt-3 flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={chosen ? `My ${chosen.name.toLowerCase()}` : "Project name…"}
            className="flex-1 rounded-md border border-line bg-surface-2 px-3 py-2 text-sm outline-none placeholder:text-ink-faint focus:border-accent-dim"
          />
          <button
            type="submit"
            disabled={!name.trim() || create.isPending}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-surface-0 transition-opacity disabled:opacity-40"
          >
            {create.isPending ? "Creating…" : "Start"}
          </button>
        </div>
      </form>

      {isLoading && <p className="text-sm text-ink-faint">Loading…</p>}
      {projects?.length === 0 && (
        <div className="rounded-lg border border-dashed border-line p-10 text-center text-sm text-ink-faint">
          No projects yet. Pick what you're building above — a coin-cell sensor, a LoRa node, a
          flight computer…
        </div>
      )}
      <ul className="flex flex-col gap-2">
        {projects?.map((p) => (
          <li
            key={p.id}
            className="group flex items-center justify-between rounded-lg border border-line bg-surface-1 px-4 py-3"
          >
            <Link to="/projects/$projectId" params={{ projectId: p.id }} className="flex-1">
              <div className="text-sm font-medium text-ink hover:text-accent">{p.name}</div>
              <div className="num text-[11px] text-ink-faint">
                created {new Date(p.createdAt).toLocaleString()}
              </div>
            </Link>
            <button
              onClick={() => remove.mutate(p.id)}
              className="invisible rounded px-2 py-1 text-xs text-ink-faint hover:text-danger group-hover:visible"
              title="Delete project"
            >
              delete
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
