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
  let groups = stage(config, path.join(work, "src/content/docs"), path.join(work, "public/_docs-assets"));
  const label = (name) => config.sidebar.find((e) => e.dir === name)?.label ?? name.charAt(0).toUpperCase() + name.slice(1).replace(/[-_]/g, " ");
  // The folders the config lists come first, in its order; the rest follow A to Z.
  const listed = config.sidebar.map((e) => e.dir).filter((d) => groups.includes(d));
  groups = [...listed, ...groups.filter((g) => !listed.includes(g))];
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
        customCss: [path.join(SITE, "src/styles.css")],
        sidebar: groups.length
          ? groups.map((g) => ({ label: label(g), items: [{ autogenerate: { directory: g } }] }))
          : undefined,
      }),
      react(),
      diagramsScript(),
    ],
    vite: {
      plugins: [projectPlugin(config), docsWatchPlugin(config, path.join(work, "src/content/docs"), path.join(work, "public/_docs-assets"))],
      server: { fs: { allow: [PACKAGE, config.root, work] } },
      // From the work folder, Vite leaves these integrations to Node, which
      // can't load the astro: modules they import. Bundle them instead.
      ssr: { noExternal: INTEGRATIONS },
      environments: { prerender: { resolve: { noExternal: INTEGRATIONS } } },
    },
  };
}

/** Every page loads site/src/diagrams.tsx, which draws the live diagrams. */
function diagramsScript() {
  return {
    name: "in-ctrl-diagrams",
    hooks: {
      "astro:config:setup": ({ injectScript }) => {
        // These React roots are not Astro islands. Run the renderer's
        // preamble before importing modules transformed for Fast Refresh.
        injectScript("page", `import "astro:scripts/before-hydration.js";\nimport(${JSON.stringify(path.join(SITE, "src/diagrams.tsx"))});`);
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
  console.log(`site written to ${outDir}`);
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
