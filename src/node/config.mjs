// A project's in-ctrl settings, from in-ctrl.config.yaml in its root:
//
//   title: Shop
//   docs: docs                 # the Markdown folder (default: docs)
//   home: README.md            # the site's front page (default: docs/README.md or README.md)
//   repo: https://github.com/you/shop
//   branch: main               # for "edit this page" links
//   site:
//     url: https://you.github.io     # where the site is served
//     base: /shop/
//     sidebar:                       # top-level docs folders, in order (default: all, A to Z)
//       - guide
//       - { dir: dev, label: Developer docs }
//       - { dir: handbook, items: [guides, { dir: reports, order: newest-first }] }  # see sidebar.mjs
//     redirects:                     # pages that moved (see redirects.mjs)
//       /guide/old/: /guide/new/
//       /old-folder/*: /new-folder/*
//   vocabulary:                # names every diagram draws the same way
//     API: { label: Shop API, icon: "gcp:cloud-run" }

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { parseRedirects } from "./redirects.mjs";

export const CONFIG_FILE = "in-ctrl.config.yaml";

export function loadConfig(root = process.cwd()) {
  root = path.resolve(root);
  const file = path.join(root, CONFIG_FILE);
  const raw = fs.existsSync(file) ? (YAML.parse(fs.readFileSync(file, "utf8")) ?? {}) : {};
  const docs = path.resolve(root, raw.docs ?? "docs");
  const home = raw.home ? path.resolve(root, raw.home) : [path.join(docs, "README.md"), path.join(root, "README.md")].find((f) => fs.existsSync(f));
  return {
    root,
    title: raw.title ?? path.basename(root),
    description: raw.description ?? "",
    docs,
    home,
    repo: raw.repo ?? "",
    branch: raw.branch ?? "main",
    base: raw.site?.base ?? "/",
    siteUrl: raw.site?.url ?? "",
    sidebar: (raw.site?.sidebar ?? []).map((e) => (typeof e === "string" ? { dir: e } : e)),
    redirects: parseRedirects(raw.site?.redirects),
    vocabulary: raw.vocabulary ?? {},
  };
}

/** Every diagram source under the docs folder: absolute paths. */
export function diagramSources(config) {
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".diagram.yaml")) out.push(full);
    }
  })(config.docs);
  return out.sort();
}

/** The PNG rendered from a diagram source, next to it. */
export function pngOf(source) {
  return source.replace(/\.diagram\.yaml$/, ".png");
}
