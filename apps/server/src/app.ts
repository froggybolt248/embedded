import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { createDb, migrateDb, type Db } from "@embedded/db";
import { projectRoutes } from "./routes/projects.js";
import { componentRoutes } from "./routes/components.js";
import { llmRoutes } from "./routes/llm.js";
import { datasheetRoutes } from "./routes/datasheets.js";
import { kicadRoutes } from "./routes/kicad.js";
import { blockRoutes } from "./routes/blocks.js";
import { connectionRoutes } from "./routes/connections.js";
import { seedArchetypes } from "./services/seed.js";

export interface AppOptions {
  db?: Db;
}

export function buildApp(opts: AppOptions = {}) {
  const app = Fastify({ logger: true });

  const db = opts.db ?? createDb();
  migrateDb(db);
  seedArchetypes(db);
  app.decorate("db", db);

  // Registered here rather than inside a route plugin because two sibling
  // scopes now take file uploads (/datasheets and /components/:id/datasheet),
  // and a plugin registered inside one scope is invisible to the other — the
  // upload route typechecks fine and then throws "req.file is not a function"
  // at runtime.
  app.register(multipart, { limits: { files: 1, fileSize: 50 * 1024 * 1024 } });

  app.get("/api/health", async () => ({ ok: true, version: "0.1.0" }));
  app.register(projectRoutes, { prefix: "/api" });
  app.register(componentRoutes, { prefix: "/api" });
  app.register(llmRoutes, { prefix: "/api" });
  app.register(datasheetRoutes, { prefix: "/api" });
  app.register(kicadRoutes, { prefix: "/api" });
  app.register(blockRoutes, { prefix: "/api" });
  app.register(connectionRoutes, { prefix: "/api" });

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
  }
}

