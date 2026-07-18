import { defineConfig } from "tsup";

/**
 * Production bundle for the server entry.
 *
 * The workspace packages export raw `./src/index.ts`, so they cannot be run by
 * plain `node` — we inline them (`noExternal`) into dist/main.js. Everything on
 * npm stays external and is resolved from a real, flat node_modules at runtime
 * (produced for the portable bundle via `pnpm deploy`). That keeps the two
 * native modules (better-sqlite3, @napi-rs/canvas) and their friends in their
 * installed form rather than fighting the bundler.
 */
export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  outDir: "dist",
  target: "node22",
  noExternal: [/^@embedded\//],
  external: ["better-sqlite3", "@napi-rs/canvas"],
  clean: true,
  // Some inlined CJS deps (e.g. cross-spawn via execa) call `require(...)` for
  // Node builtins. esbuild's ESM output otherwise stubs that with a throwing
  // shim; give it a real `require` derived from import.meta.url.
  banner: {
    js: "import { createRequire as __embeddedCreateRequire } from 'module'; const require = __embeddedCreateRequire(import.meta.url);",
  },
});
