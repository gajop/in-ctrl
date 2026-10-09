// A Vite server for the render page (render/), serving one project's diagrams.

import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";
import { projectPlugin } from "./project.mjs";

const PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export async function startRenderServer(config, { port = 0, open = false } = {}) {
  const server = await createServer({
    configFile: false,
    root: path.join(PACKAGE, "render"),
    plugins: [react(), projectPlugin(config)],
    server: { port, host: "127.0.0.1", open, fs: { allow: [PACKAGE, config.root] } },
    logLevel: "error",
  });
  await server.listen();
  return { server, url: server.resolvedUrls.local[0] };
}
