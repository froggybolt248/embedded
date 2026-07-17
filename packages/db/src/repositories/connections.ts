import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { Connection, CreateConnectionInput, UpdateConnectionInput } from "@embedded/core";
import type { Db } from "../client.js";
import { connections } from "../schema.js";

function rowToConnection(row: typeof connections.$inferSelect): Connection {
  return Connection.parse({
    ...row,
    attrs: typeof row.attrs === "string" ? JSON.parse(row.attrs) : row.attrs,
  });
}

export function createConnectionsRepo(db: Db) {
  return {
    listByProject(projectId: string): Connection[] {
      return db
        .select()
        .from(connections)
        .where(eq(connections.projectId, projectId))
        .all()
        .map(rowToConnection);
    },

    get(id: string): Connection | undefined {
      const row = db.select().from(connections).where(eq(connections.id, id)).get();
      return row ? rowToConnection(row) : undefined;
    },

    create(projectId: string, input: CreateConnectionInput): Connection {
      const parsed = CreateConnectionInput.parse(input);
      const row: typeof connections.$inferInsert = {
        id: nanoid(),
        projectId,
        fromBlockId: parsed.fromBlockId,
        fromPort: parsed.fromPort ?? "",
        toBlockId: parsed.toBlockId,
        toPort: parsed.toPort ?? "",
        interface: parsed.interface,
        attrs: parsed.attrs ?? {},
      };
      db.insert(connections).values(row).run();
      return rowToConnection(row as typeof connections.$inferSelect);
    },

    update(id: string, input: UpdateConnectionInput): Connection | undefined {
      const parsed = UpdateConnectionInput.parse(input);
      const existing = db.select().from(connections).where(eq(connections.id, id)).get();
      if (!existing) return undefined;

      const patch: Partial<typeof connections.$inferInsert> = {};
      if (parsed.fromBlockId !== undefined) patch.fromBlockId = parsed.fromBlockId;
      if (parsed.fromPort !== undefined) patch.fromPort = parsed.fromPort;
      if (parsed.toBlockId !== undefined) patch.toBlockId = parsed.toBlockId;
      if (parsed.toPort !== undefined) patch.toPort = parsed.toPort;
      if (parsed.interface !== undefined) patch.interface = parsed.interface;
      if (parsed.attrs !== undefined) patch.attrs = parsed.attrs;

      if (Object.keys(patch).length > 0) {
        db.update(connections).set(patch).where(eq(connections.id, id)).run();
      }
      const row = db.select().from(connections).where(eq(connections.id, id)).get();
      return row ? rowToConnection(row) : undefined;
    },

    remove(id: string): void {
      db.delete(connections).where(eq(connections.id, id)).run();
    },
  };
}
