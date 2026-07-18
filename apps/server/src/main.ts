import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import fastifyStatic from "@fastify/static";
import { buildApp } from "./app.js";

const PORT = Number(process.env["EMBEDDED_PORT"] ?? 4517);

const app = buildApp();

// In production the built web app is served from the same process;
// in dev, Vite serves the frontend and proxies /api here.
const webDist = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "dist");
if (existsSync(webDist)) {
  app.register(fastifyStatic, {
    root: webDist,
    // Take full control of caching (the default emits `max-age=0` for every
    // file, which would override the rule below): assets are content-hashed so
    // cache them hard; index.html is the entry that names those hashes, so it
    // must always revalidate — otherwise a browser that saw an older build
    // keeps serving a stale UI after an update.
    cacheControl: false,
    setHeaders: (res, filePath) => {
      const p = filePath.replace(/\\/g, "/");
      res.setHeader(
        "cache-control",
        p.endsWith("/index.html") || p.endsWith("index.html")
          ? "no-cache"
          : "public, max-age=31536000, immutable",
      );
    },
  });
  app.setNotFoundHandler((req, reply) => {
    if (req.raw.url?.startsWith("/api/")) {
      return reply.code(404).send({ error: "not found" });
    }
    return reply.sendFile("index.html");
  });
}

// On watch-mode restarts the previous process can hold the port for a
// moment — retry briefly instead of dying and waiting for the next change.
async function listenWithRetry(retries = 10, delayMs = 300): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await app.listen({ port: PORT, host: "127.0.0.1" });
      console.log(`embedded server on http://localhost:${PORT}`);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EADDRINUSE" || attempt >= retries) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

listenWithRetry().catch((err) => {
  app.log.error(err);
  process.exit(1);
});

