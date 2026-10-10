// The review app: the project's pages (review.pages, plus index.html), with
// in-ctrl's review elements (review/src) and the data `in-ctrl review gen`
// writes into the project's generated/ folder. Vite's root is the project's
// review folder, so pages and data are its; the app's code is this package's.
//
// Pages don't load the app themselves: every page gets it. The project adds
// its own elements with review.client (a module), and points imports
// elsewhere with review.alias (e.g. one React for the app and its elements).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { reviewApi } from "./api.mjs";

const PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const APP = path.join(PACKAGE, "review/src/main.ts");
const MAIN = "/@in-ctrl-review/main.ts";
const SETTINGS = "virtual:in-ctrl-review";
const CLIENT = "virtual:in-ctrl-review-client";

/** Vite's config for the review of `project` (loadConfig with a `review` section). */
export function viteConfig(project) {
  const review = project.review;
  const html = [path.join(project.root, "index.html"), ...htmlFiles(review.pages)].filter((f) => fs.existsSync(f));
  return {
    configFile: false,
    root: project.root,
    // The project's own public/ (images, examples) is served at /.
    publicDir: path.join(project.root, "public"),
    logLevel: "warn",
    esbuild: { jsx: "automatic" },
    resolve: {
      alias: Object.entries(review.alias).map(([name, target]) => ({
        find: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(/.*)?$`),
        replacement: `${target}$1`,
      })),
    },
    worker: { format: "es" },
    build: { target: "esnext", chunkSizeWarningLimit: 2500, rollupOptions: { input: html } },
    server: {
      fs: { allow: [project.root, review.repo, PACKAGE] },
      // Builds, releases and the comments aren't sources: leave them unwatched.
      watch: { ignored: ["previews", "releases", "live", "live.next", "dist-review"].map((d) => path.join(project.root, d, "**")).concat([project.comments, review.inbox].filter(Boolean)) },
    },
    plugins: [reviewPlugin(project)],
  };
}

/** Every page gets the app; the app gets its settings, the project's elements, and the API. */
function reviewPlugin(project) {
  const review = project.review;
  const settings = { title: project.title, name: review.name, storageKey: review.storageKey, mapsPage: review.mapsPage, baseBranch: review.baseBranch };
  return {
    name: "in-ctrl-review",
    resolveId(id) {
      if (id === MAIN) return APP;
      if (id === SETTINGS || id === CLIENT) return `\0${id}`;
      return null;
    },
    load(id) {
      if (id === `\0${SETTINGS}`) return `export default ${JSON.stringify(settings)};`;
      if (id === `\0${CLIENT}`) return review.client ? `import ${JSON.stringify(review.client)};` : "";
      return null;
    },
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        // Pages written for the app before it moved here load /src/main.ts; the app is in-ctrl's now.
        const page = html.replace(/\s*<script type="module" src="\/src\/main\.ts"><\/script>/, "");
        return { html: page, tags: [{ tag: "script", attrs: { type: "module", src: MAIN }, injectTo: "head" }] };
      },
    },
    configureServer(server) {
      const api = reviewApi(project);
      server.httpServer?.once("close", api.close);
      server.middlewares.use((req, res, next) => {
        if (!api.handle(req, res)) next();
      });
    },
  };
}

function htmlFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return htmlFiles(full);
    return entry.name.endsWith(".html") ? [full] : [];
  });
}
