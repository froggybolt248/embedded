import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import type { Project } from "@embedded/core";
import { api } from "../../lib/api";
import { Button, TextInput } from "../../components/ui";

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

  const chosen = archetypes?.find((a) => a.id === archetypeId);

  return (
    <div className="mx-auto max-w-3xl p-8">
      <h1 className="mb-1 text-xl font-semibold">Projects</h1>
      <p className="mb-6 text-sm text-ink-dim">Pick a starting point, or start blank.</p>

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
                <div className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-ink-faint">
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
              Empty canvas — add your own blocks.
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
          No projects yet — pick a starting point above.
        </div>
      )}
      <ul className="flex flex-col gap-2">
        {projects?.map((p) => (
          <ProjectRow key={p.id} project={p} />
        ))}
      </ul>
    </div>
  );
}

/**
 * One project in the list. Rename and delete are always visible — hidden
 * hover-only controls read as "this app can't do that". Delete asks once,
 * inline, instead of a modal.
 */
function ProjectRow({ project }: { project: Project }) {
  const qc = useQueryClient();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(project.name);
  const [confirming, setConfirming] = useState(false);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["projects"] });

  const rename = useMutation({
    mutationFn: () => api.projects.update(project.id, { name: draft.trim() }),
    onSuccess: () => {
      setRenaming(false);
      invalidate();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.projects.remove(project.id),
    onSuccess: invalidate,
  });

  return (
    <li className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface-1 px-4 py-3">
      {renaming ? (
        <form
          className="flex flex-1 items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim()) rename.mutate();
          }}
        >
          <TextInput
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setRenaming(false)}
            autoFocus
            className="flex-1"
          />
          <Button type="submit" variant="primary" size="sm" disabled={!draft.trim() || rename.isPending}>
            Save
          </Button>
          <Button type="button" variant="subtle" size="sm" onClick={() => setRenaming(false)}>
            Cancel
          </Button>
        </form>
      ) : (
        <Link to="/projects/$projectId" params={{ projectId: project.id }} className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-ink hover:text-accent">{project.name}</div>
          <div className="num text-[11px] text-ink-faint">
            created {new Date(project.createdAt).toLocaleDateString()}
          </div>
        </Link>
      )}

      {!renaming && (
        <div className="flex shrink-0 items-center gap-1">
          {confirming ? (
            <>
              <span className="text-[11px] text-ink-dim">Delete this project?</span>
              <Button variant="danger" size="sm" onClick={() => remove.mutate()} disabled={remove.isPending}>
                Delete
              </Button>
              <Button variant="subtle" size="sm" onClick={() => setConfirming(false)}>
                Keep
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="subtle"
                size="sm"
                onClick={() => {
                  setDraft(project.name);
                  setRenaming(true);
                }}
              >
                Rename
              </Button>
              <Button variant="danger" size="sm" onClick={() => setConfirming(true)}>
                Delete
              </Button>
            </>
          )}
        </div>
      )}
    </li>
  );
}
