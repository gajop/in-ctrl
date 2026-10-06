// The site's sidebar: one group per top-level docs folder.
//
// A folder the config lists only by name (or `{ dir, label }`) is listed by
// Starlight itself, A to Z, as before. A folder given `items` or `order` is
// laid out here instead, so its sub-folders can be named and ordered too:
//
//   sidebar:
//     - dir: handbook
//       label: Handbook
//       items:                    # sub-folders, in this order; the rest follow A to Z
//         - { dir: guides, label: Guides }
//         - reference              # labelled "Reference"
//         - { dir: articles, label: Reports, order: newest-first }
//
// `order` is how a folder's pages are listed: `az` (the default) or
// `newest-first`, for reports: pages with a `number` (front matter, see
// stage.mjs) highest first, then the rest Z to A by file name. A folder's own
// page (its README) always comes first, then pages marked `pinned: true`.
// `collapsed: true` starts a group closed.

import fs from "node:fs";
import path from "node:path";
import { splitFrontMatter } from "./stage.mjs";

const ORDERS = ["az", "newest-first"];

/** "living" → "Living", "getting-started" → "Getting started". */
export function labelOf(name) {
  return name.charAt(0).toUpperCase() + name.slice(1).replace(/[-_]/g, " ");
}

/** A sidebar entry as a `{ dir, label?, order?, collapsed?, items? }` object. */
function entryOf(e) {
  const entry = typeof e === "string" ? { dir: e } : { ...e };
  if (!entry.dir) throw new Error(`in-ctrl: a sidebar entry has no dir: ${JSON.stringify(e)}`);
  if (entry.order && !ORDERS.includes(entry.order)) {
    throw new Error(`in-ctrl: sidebar order "${entry.order}" for ${entry.dir} is not one of ${ORDERS.join(", ")}`);
  }
  return entry;
}

/** Whether a folder is laid out here rather than by Starlight. */
function explicit(entry) {
  return Boolean(entry.items || entry.order);
}

/**
 * Starlight's sidebar for the staged pages in `docsOut` (src/content/docs),
 * given the top-level folders that hold pages (`groups`) and the config.
 */
export function sidebarFor(config, docsOut, groups) {
  const entries = config.sidebar.map(entryOf);
  const listed = entries.map((e) => e.dir).filter((d) => groups.includes(d));
  const ordered = [...listed, ...groups.filter((g) => !listed.includes(g))];
  return ordered.map((dir) => {
    const entry = entries.find((e) => e.dir === dir) ?? { dir };
    if (!explicit(entry)) {
      return withCollapsed({ label: entry.label ?? labelOf(dir), items: [{ autogenerate: { directory: dir } }] }, entry);
    }
    return group(path.join(docsOut, dir), dir, entry);
  });
}

function withCollapsed(group, entry) {
  return entry.collapsed === undefined ? group : { ...group, collapsed: Boolean(entry.collapsed) };
}

/** One folder as a sidebar group: its own page, its pages, then its sub-folders. */
function group(folder, slug, entry) {
  const children = (entry.items ?? []).map(entryOf);
  const names = fs.existsSync(folder) ? fs.readdirSync(folder, { withFileTypes: true }) : [];
  const pages = names.filter((e) => e.isFile() && e.name.endsWith(".md") && !e.name.startsWith("_")).map((e) => e.name.slice(0, -3));
  const folders = names.filter((e) => e.isDirectory() && holdsPages(path.join(folder, e.name))).map((e) => e.name).sort();

  const items = [];
  if (pages.includes("index")) items.push({ slug });
  const meta = new Map(pages.map((p) => [p, pageMeta(path.join(folder, `${p}.md`))]));
  const others = pages.filter((p) => p !== "index").sort();
  const pinned = others.filter((p) => meta.get(p).pinned);
  let rest = others.filter((p) => !meta.get(p).pinned);
  if (entry.order === "newest-first") {
    const numbered = rest.filter((p) => meta.get(p).number !== undefined).sort((a, b) => meta.get(b).number - meta.get(a).number);
    rest = [...numbered, ...rest.filter((p) => meta.get(p).number === undefined).reverse()];
  }
  for (const page of [...pinned, ...rest]) items.push({ slug: `${slug}/${page}` });

  const named = children.map((c) => c.dir).filter((d) => folders.includes(d));
  for (const dir of [...named, ...folders.filter((f) => !named.includes(f))]) {
    const child = children.find((c) => c.dir === dir) ?? { dir };
    items.push(group(path.join(folder, dir), `${slug}/${dir}`, child));
  }
  return withCollapsed({ label: entry.label ?? labelOf(path.basename(slug)), items }, entry);
}

/** A staged page's `number` and `pinned`, from its front matter. */
function pageMeta(file) {
  const { meta } = splitFrontMatter(fs.readFileSync(file, "utf8"), file);
  return { number: meta.number, pinned: meta.pinned === true };
}

/** Whether a staged folder has a page anywhere below it. */
function holdsPages(folder) {
  for (const e of fs.readdirSync(folder, { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith(".md")) return true;
    if (e.isDirectory() && holdsPages(path.join(folder, e.name))) return true;
  }
  return false;
}
