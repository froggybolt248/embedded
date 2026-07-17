import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The server binds 127.0.0.1:4517 by default; EMBEDDED_API_URL overrides for non-default setups.
const apiTarget = process.env.EMBEDDED_API_URL ?? "http://localhost:4517";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 4518,
    proxy: {
      "/api": apiTarget,
    },
  },
});
