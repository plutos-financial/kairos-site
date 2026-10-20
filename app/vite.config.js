import { defineConfig } from "vite";
import { resolve } from "node:path";

const page = (f) => resolve(import.meta.dirname, f);
// Each build gets an id. Pages compare it with version.json so a stale cached copy reloads itself.
const build = Date.now().toString(36);
export default defineConfig({
  base: "./",
  define: { __BUILD_ID__: JSON.stringify(build) },
  plugins: [
    {
      name: "version-file",
      generateBundle() {
        this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ build }) + "\n" });
      },
    },
  ],
  build: {
    // Everything lands in one flat folder (no "assets" subfolder), so uploading to GitHub is just
    // "select all files, drag, commit". Safari's GitHub uploader skips folders.
    assetsDir: "",
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      // no file names starting with "_" (some hosts hide those)
      output: { chunkFileNames: (c) => `${c.name.replace(/^_+/, "")}-[hash].js` },
      input: { main: page("index.html"), app: page("app.html"), control: page("control.html"), admin: page("admin.html"), deploy: page("deploy.html"), winners: page("winners.html"), how: page("how-it-works.html") },
    },
  },
});
