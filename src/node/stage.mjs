// Turn a project's Markdown into the content the docs site builds from, without
// asking authors to change anything:
//
// - the first `# Heading` becomes the page title (Starlight's frontmatter);
// - README.md in a folder becomes that folder's page; the project README is
//   the home page; a top-level INDEX.md becomes /contents/;
// - links to other docs become site links; links to anything else in the
//   repository (code, examples) go to GitHub;
// - an image whose source is a diagram (x.png next to x.diagram.yaml) becomes
//   a live diagram, with the PNG kept for readers without JavaScript.

import fs from "node:fs";
import path from "node:path";

/**
 * Stage the docs: pages into `out`, the images they show into `assets` (served
 * as /_docs-assets/). Returns the top-level folders, for the sidebar.
 */
export function stage(config, out, assets, { incremental = false } = {}) {
  for (const dir of [out, assets]) {
    if (!incremental) fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  }
  const expected = new Set();
  const write = (target, content) => {
    expected.add(target);
    const bytes = Buffer.from(content);
    if (fs.existsSync(target) && fs.readFileSync(target).equals(bytes)) return;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  };
  const pages = new Map(); // absolute source path → slug ("" is the home page)
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else files.push(full);
    }
  })(config.docs);
  for (const f of files.filter((f) => f.endsWith(".md"))) {
    const slug = slugOf(config, f);
    // docs/README.md can't take the home page's place.
    pages.set(f, slug === "index" && config.home ? "overview" : slug);
  }
  if (config.home) pages.set(config.home, "");

  for (const [source, slug] of pages) {
    const text = fs.readFileSync(source, "utf8");
    const target = path.join(out, slug === "" ? "index.md" : `${slug}.md`);
    write(target, transform(config, source, text, pages));
  }
  // Images the pages show, next to them.
  for (const f of files.filter((f) => /\.(png|jpe?g|gif|svg|webp)$/i.test(f))) {
    const target = path.join(assets, path.relative(config.docs, f));
    write(target, fs.readFileSync(f));
  }
  if (incremental) {
    const prune = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) prune(full);
        else if (!expected.has(full)) fs.unlinkSync(full);
      }
    };
    for (const dir of [out, assets]) prune(dir);
  }
  // Asset-only folders have no pages for Starlight to list.
  return [...new Set([...pages.values()].filter((slug) => slug.includes("/")).map((slug) => slug.split("/")[0]))].sort();
}

function slugOf(config, file) {
  const rel = path.relative(config.docs, file).replace(/\\/g, "/").replace(/\.md$/, "");
  if (rel === "INDEX" || rel === "index") return "contents";
  const parts = rel.split("/");
  if (/^readme$/i.test(parts.at(-1))) parts[parts.length - 1] = "index";
  return parts.map((p) => p.toLowerCase().replace(/[^a-z0-9._-]+/g, "-")).join("/");
}

function routeOf(config, slug) {
  const base = config.base.endsWith("/") ? config.base : `${config.base}/`;
  const path = slug === "index" ? "" : slug.replace(/\/index$/, "");
  return path ? `${base}${path}/` : base;
}

function transform(config, source, text, pages) {
  const lines = text.split("\n");
  let title = path.basename(source, ".md");
  const h1 = lines.findIndex((l) => /^# /.test(l));
  if (h1 !== -1) {
    title = lines[h1].slice(2).trim();
    lines.splice(h1, 1);
  }
  const dir = path.dirname(source);
  let body = lines.join("\n");
  // Images first: a diagram's PNG becomes a live diagram.
  body = body.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (whole, alt, src) => {
    if (/^[a-z]+:/i.test(src)) return whole;
    const abs = path.resolve(dir, src);
    const yaml = abs.replace(/\.png$/, ".diagram.yaml");
    if (abs.endsWith(".png") && fs.existsSync(yaml)) {
      const key = path.relative(config.root, yaml).replace(/\\/g, "/");
      return `<figure class="in-ctrl-figure"><div class="in-ctrl-diagram" data-file="${key}" role="img" aria-label="${escapeAttr(alt)}"></div><noscript><img src="${imageRoute(config, abs)}" alt="${escapeAttr(alt)}"></noscript>${alt ? `<figcaption>${escapeHtml(alt)}</figcaption>` : ""}</figure>`;
    }
    return abs.startsWith(config.docs) ? `![${alt}](${imageRoute(config, abs)})` : `![${alt}](${githubUrl(config, abs, "raw")})`;
  });
  // Then links.
  body = body.replace(/(?<!!)\[([^\]]*)\]\(([^)\s]+)\)/g, (whole, label, href) => {
    if (/^([a-z]+:|#|\/)/i.test(href)) return whole;
    const [target, hash = ""] = href.split("#");
    const abs = path.resolve(dir, decodeURI(target));
    const anchor = hash ? `#${hash}` : "";
    if (pages.has(abs)) return `[${label}](${routeOf(config, pages.get(abs))}${anchor})`;
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory() && pages.has(path.join(abs, "README.md"))) return `[${label}](${routeOf(config, pages.get(path.join(abs, "README.md")))}${anchor})`;
    return `[${label}](${githubUrl(config, abs, fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? "tree" : "blob")}${anchor})`;
  });
  const front = [`title: ${JSON.stringify(title)}`];
  front.push(config.repo ? `editUrl: ${JSON.stringify(githubUrl(config, source, "edit"))}` : "editUrl: false");
  if (source === config.home) {
    front.push("template: splash", "hero:", `  title: ${JSON.stringify(title)}`);
    if (config.description) front.push(`  tagline: ${JSON.stringify(config.description)}`);
    const start = [...pages.values()].includes("contents") ? "contents" : [...pages.values()].find((s) => s !== "");
    front.push("  actions:");
    if (start) front.push("    - text: Read the docs", `      link: ${JSON.stringify(routeOf(config, start))}`, "      icon: right-arrow");
    if (config.repo) front.push("    - text: GitHub", `      link: ${JSON.stringify(config.repo)}`, "      icon: github", "      variant: minimal");
  }
  return `---\n${front.join("\n")}\n---\n${body.replace(/^\n+/, "")}`;
}

function imageRoute(config, abs) {
  const base = config.base.endsWith("/") ? config.base : `${config.base}/`;
  return `${base}_docs-assets/${path.relative(config.docs, abs).replace(/\\/g, "/")}`;
}

function githubUrl(config, abs, kind) {
  const rel = path.relative(config.root, abs).replace(/\\/g, "/");
  if (!config.repo) return rel;
  return `${config.repo.replace(/\/$/, "")}/${kind}/${config.branch}/${rel}`;
}

function escapeAttr(s) {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
