// The docs site: the project's Markdown and live diagrams, built by Astro
// Starlight (navigation, search, dark mode) from the package's site/ template.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@astrojs/react";
import starlight from "@astrojs/starlight";
import { stage } from "./stage.mjs";
import { projectPlugin } from "./project.mjs";
import { docsWatchPlugin } from "./docs-watch.mjs";
import { sidebarFor } from "./sidebar.mjs";
import { writeRedirectPages } from "./redirects.mjs";
import { commentsPlugin } from "./comments.mjs";

const PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SITE = path.join(PACKAGE, "site");
const INTEGRATIONS = ["@astrojs/starlight", "@astrojs/react"];

/**
 * A working folder for one build, outside this package and outside the
 * project: the staged pages, the images they show, Astro's caches.
 */
function workFolder() {
  // Astro misreads paths outside its root when the two share no folder but
  // "/" (it takes them as relative to the root). So the work folder goes in
  // the temp folder only if that shares a top folder with this package.
  const top = (p) => path.resolve(p).split(path.sep)[1];
  const parent = top(os.tmpdir()) === top(PACKAGE) ? os.tmpdir() : path.join(os.homedir(), ".cache");
  fs.mkdirSync(parent, { recursive: true });
  const work = fs.mkdtempSync(path.join(parent, "in-ctrl-site-"));
  fs.mkdirSync(path.join(work, "src"));
  fs.copyFileSync(path.join(SITE, "src/content.config.ts"), path.join(work, "src/content.config.ts"));
  // Starlight derives sidebar folders from src/content/docs, independently
  // of the glob loader's base. Keep staging and navigation on the same path.
  process.env.IN_CTRL_CONTENT = path.join(work, "src/content");
  // Astro runs its prerender bundle from here; let it find this package's
  // dependencies (react, starlight) the way it would next to the package.
  fs.symlinkSync(dependencies(), path.join(work, "node_modules"), "junction");
  return work;
}

/** The node_modules folder this package's dependencies are installed in. */
function dependencies() {
  for (let dir = PACKAGE; ; dir = path.dirname(dir)) {
    const modules = path.basename(dir) === "node_modules" ? dir : path.join(dir, "node_modules");
    if (fs.existsSync(path.join(modules, "react"))) return modules;
    if (dir === path.dirname(dir)) throw new Error("in-ctrl: can't find its dependencies (react)");
  }
}

function astroConfig(config, outDir, work) {
  const docsOut = path.join(work, "src/content/docs");
  const groups = stage(config, docsOut, path.join(work, "public/_docs-assets"));
  // The folders the config lists come first, in its order; the rest follow A to Z.
  const sidebar = groups.length ? sidebarFor(config, docsOut, groups) : undefined;
  return {
    configFile: false,
    root: work,
    srcDir: path.join(work, "src"),
    publicDir: path.join(work, "public"),
    cacheDir: path.join(work, "cache"),
    outDir,
    base: config.base,
    site: config.siteUrl || undefined,
    logLevel: "warn",
    integrations: [
      starlight({
        title: config.title,
        description: config.description || undefined,
        social: config.repo ? [{ icon: "github", label: "GitHub", href: config.repo }] : [],
        customCss: [path.join(SITE, "src/styles.css"), ...(config.comments ? [path.join(SITE, "src/comments.css")] : [])],
        sidebar,
        // Before the page paints: hide the sidebar or the table of contents if the reader did.
        head: [{ tag: "script", content: LAYOUT_STATE }],
      }),
      react(),
      diagramsScript(config),
    ],
    vite: {
      plugins: [
        projectPlugin(config),
        docsWatchPlugin(config, path.join(work, "src/content/docs"), path.join(work, "public/_docs-assets")),
        ...(config.comments ? [commentsPlugin(config)] : []),
      ],
      server: { fs: { allow: [PACKAGE, config.root, work] } },
      // The page scripts load through dynamic imports Vite doesn't scan up front; it would
      // find their dependencies on first view and reload the page (losing an open comment).
      optimizeDeps: { include: ["react", "react-dom/client", "react/jsx-dev-runtime", "@xyflow/react", "elkjs/lib/elk.bundled.js", "yaml"] },
      // From the work folder, Vite leaves these integrations to Node, which
      // can't load the astro: modules they import. Bundle them instead.
      ssr: { noExternal: INTEGRATIONS },
      environments: { prerender: { resolve: { noExternal: INTEGRATIONS } } },
    },
  };
}

/** The reader's choice to hide the sidebar or the table of contents, set on <html> before paint. */
const LAYOUT_STATE = `for (const part of ["sidebar", "toc"]) { try { if (localStorage.getItem("in-ctrl:" + part) === "hidden") document.documentElement.dataset["ic" + part.charAt(0).toUpperCase() + part.slice(1)] = "hidden"; } catch {} }`;

/**
 * Every page loads site/src/diagrams.tsx, which draws the live diagrams, site/src/layout.ts,
 * and, with comments on, site/src/comments.ts. That one asks the server for the comments API
 * (`site dev` and `site serve` answer it) and shows nothing where there is none, so a built
 * site keeps working on any static host.
 */
function diagramsScript(config) {
  return {
    name: "in-ctrl-diagrams",
    hooks: {
      "astro:config:setup": ({ injectScript }) => {
        // These React roots are not Astro islands. Run the renderer's
        // preamble before importing modules transformed for Fast Refresh.
        injectScript("page", `import "astro:scripts/before-hydration.js";\nimport(${JSON.stringify(path.join(SITE, "src/diagrams.tsx"))});`);
        injectScript("page", `import(${JSON.stringify(path.join(SITE, "src/layout.ts"))});`);
        if (config.comments) injectScript("page", `import(${JSON.stringify(path.join(SITE, "src/comments.ts"))});`);
      },
    },
  };
}

export async function buildSite(config, outDir) {
  const { build } = await import("astro");
  const out = path.resolve(outDir);
  const work = workFolder();
  process.chdir(work);
  try {
    await build(astroConfig(config, out, work));
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  const moved = writeRedirectPages(config.redirects ?? [], out, config.base);
  console.log(`site written to ${outDir}${moved.length ? ` (${moved.length} redirect pages)` : ""}`);
}

export async function devSite(config) {
  const { dev } = await import("astro");
  const work = workFolder();
  process.chdir(work);
  const cleanUp = () => fs.rmSync(work, { recursive: true, force: true });
  process.on("exit", cleanUp);
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit());
  const server = await dev(astroConfig(config, path.join(work, "dist"), work));
  console.log(`site on http://localhost:${server.address.port}${config.base}`);
}
