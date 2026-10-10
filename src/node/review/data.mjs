// `in-ctrl review gen`: the data the review's pages render from, in the
// project's generated/ folder:
//   generated/refs.json       code references (path#symbol) resolved to lines
//   generated/pages.json      page index for navigation
//   generated/branches/*.json per-branch commit, file stats and patches
//   generated/sources/*.json  the referenced files' text, for the in-page code viewer
// With `check`, unresolved references fail instead of only warning.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { marked } from "marked";
import YAML from "yaml";
import { buildIcons } from "../icons.mjs";

// Set by generate() for the helpers below: one project per run.
let GUIDE;
let REPO;
let OUT;
let config;
let maps;
let containerRules;
let duplicates;

/** Generate the review's data for `project` (loadConfig with a `review` section); returns 0, or 1 when `check` finds problems. */
export function generate(project, { check: CHECK = false } = {}) {
  GUIDE = project.root;
  config = project.review;
  REPO = config.repo;
  OUT = path.join(GUIDE, "generated");
  // The structure and flow maps review pages are placed on (maps.yaml, optional).
  const mapsFile = path.join(GUIDE, "maps.yaml");
  maps = fs.existsSync(mapsFile) ? YAML.parse(fs.readFileSync(mapsFile, "utf8")) : { structure: { context: [], containers: [] }, flows: [] };
  containerRules = maps.structure.containers.map((c) => ({ id: c.id, res: (c.paths ?? []).map((p) => new RegExp(p)) }));

  fs.mkdirSync(path.join(OUT, "branches"), { recursive: true });

  duplicates = [];
  const pages = collectPages();
  const refs = resolveRefs(collectRefs(pages));
  const branches = collectBranches();

  write("pages.json", pages);
  write("diagrams.json", collectDiagrams());
  // Which guide page shows each repository doc, so a diagram's links open the guide's page.
  {
    const docPages = {};
    for (const page of pages) {
      const html = fs.readFileSync(path.join(GUIDE, page.path), "utf8");
      for (const m of html.matchAll(/<repo-markdown[^>]*\sfile="([^"]+)"/g)) docPages[m[1]] ??= page.path;
    }
    write("doc-pages.json", docPages);
  }
  // The docs' vocabulary (in-ctrl.config.yaml on the docs branch), and the icons
  // every diagram uses: the repository's and those on the guide's own pages.
  {
    const vocabulary = YAML.parse(readDoc("in-ctrl.config.yaml") ?? "{}")?.vocabulary ?? {};
    write("vocabulary.json", vocabulary);
    const pageTexts = walk(config.pages, ".html").map((f) => fs.readFileSync(f, "utf8"));
    const icons = buildIcons([...pageTexts, ...Object.values(JSON.parse(fs.readFileSync(path.join(OUT, "diagrams.json"), "utf8"))), JSON.stringify(vocabulary)]);
    write("guide-icons.json", icons);
  }
  write("markdown.json", renderMarkdownFiles(pages));
  write("meta.json", {
    repoRoot: REPO,
    editorLink: config.editorLink,
    annotationKinds: config.annotationKinds ?? [],
    generatedAt: new Date().toISOString(),
  });
  write("refs.json", refs);
  // A map box or flow with `doc: <repo doc>[#anchor]` links to the guide page showing that doc.
  {
    const pageOfDoc = new Map();
    for (const page of pages) {
      const html = fs.readFileSync(path.join(GUIDE, page.path), "utf8");
      for (const m of html.matchAll(/<repo-markdown[^>]*\sfile="([^"]+)"/g)) if (!pageOfDoc.has(m[1])) pageOfDoc.set(m[1], page.path);
    }
    const link = (item) => {
      if (!item.doc) return;
      const [file, hash] = item.doc.split("#");
      const page = pageOfDoc.get(file);
      if (page) item.href = `${page}${hash ? `#${hash}` : ""}`;
      else console.warn(`maps.yaml: ${item.id}: no guide page shows ${file}`);
    };
    maps.structure.containers.forEach(link);
    for (const journey of maps.flows) {
      link(journey);
      for (const flow of journey.flows) {
        link(flow);
        flow.steps.forEach(link);
      }
    }
  }
  write("maps.json", maps);
  {
    // Every guide:flows entry must name a flow or a step of maps.yaml.
    const known = new Set(maps.flows.flatMap((j) => j.flows.flatMap((f) => [f.id, ...f.steps.map((s) => `${f.id}.${s.id}`)])));
    for (const p of pages) for (const f of p.flows ?? []) if (!known.has(f)) console.warn(`review note: ${p.path}: unknown flow step ${f} (see maps.yaml)`);
  }
  writeSources(refs);
  write(
    "branches/index.json",
    branches.map(({ name, parent, subject, files, merged, commits, diagrams }) => ({
      name,
      parent,
      subject,
      merged,
      // What the review header shows, so it can draw before the branch's diff loads.
      added: files.reduce((n, f) => n + f.added, 0),
      removed: files.reduce((n, f) => n + f.removed, 0),
      commitCount: commits?.length ?? 0,
      diagrams: diagrams?.length ?? 0,
      // Lines changed per part of the project, for the impact map (review/src/glance.ts).
      impact: impactByArea(files),
      // For review progress in the sidebar; same hash as patchHash() in src/store.ts.
      files: files.map((f) => ({ file: f.file, hash: patchHash(f.hunks) })),
    })),
  );
  for (const branch of branches) {
    write(`branches/${branch.name.replaceAll("/", "__")}.json`, branch);
  }

  const noteProblems = checkNotes(pages, branches);
  for (const problem of noteProblems) console.warn(`review note: ${problem}`);
  const missing = Object.entries(refs).filter(([, r]) => !r.ok);
  const fuzzy = Object.entries(refs).filter(([, r]) => r.fuzzy);
  for (const [ref] of fuzzy) console.warn(`ref resolved only by text match (check the symbol): ${ref}`);
  for (const dup of duplicates) console.warn(`duplicate model element: ${dup}`);
  for (const [ref, r] of missing) {
    console.warn(`unresolved ref: ${ref} (${r.reason})`);
  }
  console.log(
    `review data: ${pages.length} pages, ${Object.keys(refs).length} refs (${missing.length} unresolved), ${branches.length} branches`,
  );
  return CHECK && (missing.length > 0 || duplicates.length > 0 || noteProblems.length > 0) ? 1 : 0;
}

// Helpers

function write(name, data) {
  fs.writeFileSync(path.join(OUT, name), JSON.stringify(data, null, 1));
}

/** One JSON per referenced file, loaded when the reader opens it. */
function writeSources(refs) {
  const dir = path.join(OUT, "sources");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const files = new Set(Object.values(refs).filter((r) => r.ok && r.line !== null).map((r) => r.file));
  for (const file of files) {
    const text = fs.readFileSync(path.join(REPO, file), "utf8");
    fs.writeFileSync(path.join(dir, `${sourceKey(file)}.json`), JSON.stringify({ file, text }));
  }
}

function sourceKey(file) {
  return file.replaceAll("/", "__");
}

/** A file's text at a ref, or null when it isn't there. */
function showAt(ref, file) {
  try {
    return execFileSync("git", ["show", `${ref}:${file}`], { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

function isAncestor(a, b) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", a, b], { cwd: REPO });
    return true;
  } catch {
    return false;
  }
}

/** FNV-1a over the JSON, as in src/store.ts. */
function patchHash(value) {
  let h = 0x811c9dc5;
  for (const ch of JSON.stringify(value)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

function git(...args) {
  return execFileSync("git", args, { cwd: REPO, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

function walk(dir, ext) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full, ext);
    return entry.name.endsWith(ext) ? [full] : [];
  });
}

/** Which container of the structure map (maps.yaml) a file belongs to. */
function areaOf(file) {
  // Docs and lock files count as docs and build wherever they live.
  if (file.endsWith(".md")) return "docs";
  if (/(^|\/)(Cargo\.lock|pnpm-lock\.yaml|uv\.lock|package-lock\.json)$/.test(file)) return "build";
  return containerRules.find((c) => c.res.some((re) => re.test(file)))?.id ?? "build";
}

function impactByArea(files) {
  const out = {};
  for (const f of files) {
    const a = areaOf(f.file);
    out[a] ??= { lines: 0, files: 0, added: 0, removed: 0 };
    out[a].lines += f.added + f.removed;
    out[a].added += f.added;
    out[a].removed += f.removed;
    out[a].files += 1;
  }
  return out;
}

/** Attribute text back to plain text (the page escapes quotes and the like). */
function unescape(s) {
  if (s === undefined) return undefined;
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

function collectPages() {
  return walk(config.pages, ".html")
    .map((file) => {
      const html = fs.readFileSync(file, "utf8");
      const meta = (name) => html.match(new RegExp(`<meta name="guide:${name}" content="([^"]*)"`))?.[1];
      return {
        path: "/" + path.relative(GUIDE, file).replaceAll(path.sep, "/"),
        title: html.match(/<title>([^<]*)<\/title>/)?.[1] ?? path.basename(file),
        section: meta("section") ?? "living",
        order: Number(meta("order") ?? 999),
        branch: meta("branch") ?? null,
        // A subpage: listed under this page in the sidebar.
        parent: meta("parent") ?? null,
        summary: meta("summary") ?? "",
        // The glance line of review pages (src/glance.ts).
        kind: meta("kind"),
        risk: html.match(/<review-header[^>]*\brisk="([a-z]+)"/)?.[1],
        areas: meta("areas")?.split(",").map((a) => a.trim()).filter(Boolean),
        // Steps of the flow map (maps.yaml) the branch changes, e.g. "checkout.pay.charge".
        flows: meta("flows")?.split(",").map((a) => a.trim()).filter(Boolean),
        oneliner: unescape(meta("oneliner")),
        breaking: unescape(meta("breaking")),
      };
    })
    .sort((a, b) => a.section.localeCompare(b.section) || a.order - b.order || a.title.localeCompare(b.title));
}

function collectRefs(pageList) {
  const found = new Set();
  const visit = (value) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") {
      for (const [key, v] of Object.entries(value)) {
        if (key === "code" && typeof v === "string") found.add(v);
        else visit(v);
      }
    }
  };
  const defined = new Map();
  const noteIds = (elements, file) => {
    for (const el of elements ?? []) {
      if (defined.has(el.id)) duplicates.push(`${el.id} (${defined.get(el.id)} and ${file})`);
      defined.set(el.id, file);
      noteIds(el.children, file);
    }
  };
  for (const file of fs.existsSync(path.join(GUIDE, "model")) ? walk(path.join(GUIDE, "model"), ".yaml") : []) {
    const parsed = YAML.parse(fs.readFileSync(file, "utf8"));
    noteIds(parsed?.elements, path.basename(file));
    visit(parsed);
  }
  for (const page of pageList) {
    const html = fs.readFileSync(path.join(GUIDE, page.path), "utf8");
    for (const match of html.matchAll(/\bref="([^"]+)"/g)) found.add(match[1]);
    for (const match of html.matchAll(/<script type="application\/yaml">([\s\S]*?)<\/script>/g)) {
      visit(YAML.parse(match[1]));
    }
  }
  return [...found].sort();
}

function resolveRefs(refList) {
  const cache = new Map();
  const read = (file) => {
    if (!cache.has(file)) {
      const full = path.join(REPO, file);
      cache.set(file, fs.existsSync(full) && fs.statSync(full).isFile() ? fs.readFileSync(full, "utf8").split("\n") : null);
    }
    return cache.get(file);
  };
  return Object.fromEntries(
    refList.map((ref) => {
      const [file, symbol] = ref.split("#");
      const lines = read(file);
      if (!lines) {
        const isDir = fs.existsSync(path.join(REPO, file));
        return [ref, isDir ? { file, line: null, ok: true } : { file, line: null, ok: false, reason: "file not found" }];
      }
      if (!symbol) return [ref, { file, line: 1, ok: true }];
      const found = findSymbol(lines, symbol);
      return [
        ref,
        found
          ? { file, line: found.line, ok: true, ...(found.fuzzy ? { fuzzy: true } : {}) }
          : { file, line: null, ok: false, reason: `symbol '${symbol}' not found` },
      ];
    }),
  );
}

function findSymbol(lines, symbol) {
  const parts = symbol.split("::");
  const name = escapeRe(parts.at(-1));
  const owner = parts.length > 1 ? escapeRe(parts.at(-2)) : null;
  const patterns = [
    new RegExp(`\\b(?:fn|struct|enum|trait|type|const|static|mod|macro_rules!)\\s+${name}\\b`),
    new RegExp(`\\b(?:function|class|interface|const|let|type)\\s+${name}\\b`),
    new RegExp(`^\\s*(?:async\\s+)?def\\s+${name}\\b|^\\s*class\\s+${name}\\b`),
    new RegExp(`^\\s*${name}:`),
  ];
  let start = 0;
  if (owner) {
    const ownerRe = new RegExp(`\\b(?:impl(?:<[^>]*>)?\\s+(?:[\\w:<>, ]+\\s+for\\s+)?${owner}\\b|(?:struct|enum|trait|class)\\s+${owner}\\b)`);
    const idx = lines.findIndex((l) => ownerRe.test(l));
    if (idx >= 0) start = idx;
  }
  for (const re of patterns) {
    for (let i = start; i < lines.length; i++) {
      if (re.test(lines[i])) return { line: i + 1, fuzzy: false };
    }
  }
  const literal = lines.findIndex((l) => l.includes(parts.at(-1)));
  return literal >= 0 ? { line: literal + 1, fuzzy: true } : null;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectBranches() {
  const names = git("for-each-ref", "--format=%(refname:short)", `refs/heads/${config.branchPrefix}`)
    .split("\n")
    .filter(Boolean)
    .sort();
  // The first branch is diffed against where the stack started (stackBase),
  // not the base branch: once merged, the base branch contains it. Branches
  // outside the stack (config.branches) are diffed against their own base.
  const entries = [
    // stackParents overrides one branch's parent, e.g. the first stack branch
    // after the ones that went into the release stack.
    ...names.map((name, i) => ({ name, parent: config.stackParents?.[name] ?? (i === 0 ? (config.stackBase ?? config.baseBranch) : names[i - 1]), stack: true })),
    ...(config.branches ?? []).map((b) => ({ name: b.name, parent: b.base, stack: false })),
  ];
  return entries.map(({ name, parent, stack }, i) => {
    const range = `${parent}..${name}`;
    const [subject, ...bodyLines] = git("log", "-1", "--format=%B", name).trimEnd().split("\n");
    const body = bodyLines
      .filter((l) => !/^(Co-Authored-By|Claude-Session):/.test(l))
      .join("\n")
      .trim();
    const stats = git("diff", "--numstat", "--no-renames", range)
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [added, removed, file] = l.split("\t");
        return { file, added: Number(added) || 0, removed: Number(removed) || 0 };
      });
    const statuses = Object.fromEntries(
      git("diff", "--name-status", "--no-renames", range)
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          const [status, file] = l.split("\t");
          return [file, status[0]];
        }),
    );
    const files = stats.map((s) => ({
      ...s,
      status: statuses[s.file] ?? "M",
      hunks: parseHunks(git("diff", "-U3", "--no-renames", range, "--", s.file)),
      // Same diff ignoring whitespace; the reader's default view.
      hunksNoWs: parseHunks(git("diff", "-U3", "-w", "--no-renames", range, "--", s.file)),
      symbols: statuses[s.file] === "D" ? {} : symbolSpans(name, s.file),
      // Markdown is easier to review rendered: the file as the branch leaves it.
      ...(s.file.endsWith(".md") && statuses[s.file] !== "D" ? { preview: git("show", `${name}:${s.file}`) } : {}),
    }));
    const commit = git("rev-parse", name).trim();
    // Merged: in main, or in history that counts as merged (config.mergedRefs).
    const merged = [config.baseBranch, ...(config.mergedRefs ?? [])].some((ref) => isAncestor(name, ref));
    // Every commit in the branch, oldest first: a branch can hold several.
    const commits = git("log", "--reverse", "--format=%h%x1f%s%x1f%b%x1e", range)
      .split("\x1e")
      .map((c) => c.trim())
      .filter(Boolean)
      .map((c) => {
        const [hash, subj, text = ""] = c.split("\x1f");
        return { hash, subject: subj, body: text.split("\n").filter((l) => !/^(Co-Authored-By|Claude-Session):/.test(l)).join("\n").trim() };
      });
    // The docs diagrams the branch changes, before and after, for <branch-flows>.
    const diagrams = files
      .filter((f) => f.file.endsWith(".diagram.yaml") && f.status !== "D")
      .map((f) => ({ file: f.file, before: f.status === "A" ? null : showAt(parent, f.file), after: showAt(name, f.file) }));
    return { name, parent: i === 0 ? config.baseBranch : parent, commit, subject, body, files, merged, stack, commits, diagrams };
  });
}

/**
 * A repository doc as the guide shows it: from `review.docsRef` in the config
 * (the branch where the docs are written, or an absolute path to a checkout
 * while drafting), else from this checkout. The Markdown in the repository is
 * the only copy; the guide only renders it.
 */
function readDoc(file) {
  if (config.docsRef?.startsWith("/")) {
    const full = path.join(config.docsRef, file);
    if (fs.existsSync(full)) return fs.readFileSync(full, "utf8");
  }
  if (config.docsRef) {
    try {
      return execFileSync("git", ["show", `${config.docsRef}:${file}`], { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      // Not on that branch: fall back to this checkout or pre-cleanup branches.
    }
  }
  const full = path.join(REPO, file);
  if (fs.existsSync(full)) return fs.readFileSync(full, "utf8");
  // review.docsFallbackRefs: where docs no longer on docsRef or in the checkout still are.
  for (const ref of [...(config.docsFallbackRefs ?? []), config.stackBase, config.baseBranch]) {
    if (!ref) continue;
    try {
      return execFileSync("git", ["show", `${ref}:${file}`], { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      // Try next fallback
    }
  }
  return null;
}

/** A doc embeds a diagram's PNG, drawn from a *.diagram.yaml next to it, so it reads well on GitHub; the guide draws the diagram itself. */
function diagramsFromSource(html, file) {
  return html.replace(/<img src="([^"]+)\.png" alt="([^"]*)"[^>]*>/g, (whole, src, alt) => {
    const yaml = path.normalize(path.join(path.dirname(file), `${src}.diagram.yaml`));
    if (readDoc(yaml) === null) return whole;
    return `<figure class="md-figure"><docs-diagram file="${yaml}"></docs-diagram>${alt ? `<figcaption>${alt}</figcaption>` : ""}</figure>`;
  });
}

/** Every diagram source (docs/…/x.diagram.yaml) on the docs branch: path → source, for <docs-diagram>. */
function collectDiagrams() {
  let files = [];
  if (config.docsRef?.startsWith("/")) {
    const walkDocs = (dir) =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walkDocs(path.join(dir, e.name)) : e.name.endsWith(".diagram.yaml") ? [path.join(dir, e.name)] : []));
    files = walkDocs(path.join(config.docsRef, "docs")).map((f) => path.relative(config.docsRef, f));
  } else if (config.docsRef) {
    files = git("ls-tree", "-r", "--name-only", config.docsRef, "--", "docs").split("\n").filter((f) => f.endsWith(".diagram.yaml"));
  }
  return Object.fromEntries(files.map((f) => [f, readDoc(f)]));
}

/** GitHub-style heading ids, so links like `run.md#triggers` land on the heading. */
export function headingIds(html) {
  const used = new Map();
  return html.replace(/<h([1-6])>([\s\S]*?)<\/h\1>/g, (whole, level, inner) => {
    const base = inner
      .replace(/<[^>]+>/g, "")
      .replace(/&[a-z#0-9]+;/gi, "")
      .toLowerCase()
      .trim()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s/g, "-");
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    return `<h${level} id="${n ? `${base}-${n}` : base}">${inner}</h${level}>`;
  });
}

function renderMarkdownFiles(pageList) {
  // Which page shows each file, so links between repo docs stay inside the guide.
  const pageOf = new Map();
  for (const page of pageList) {
    const html = fs.readFileSync(path.join(GUIDE, page.path), "utf8");
    for (const match of html.matchAll(/<repo-markdown[^>]*\sfile="([^"]+)"/g)) if (!pageOf.has(match[1])) pageOf.set(match[1], page.path);
  }
  return Object.fromEntries(
    [...pageOf.keys()].map((file) => {
      let text = readDoc(file) ?? `*${file} not found*`;
      // review.hideSections: "## Heading" sections the guide leaves out of every doc (a numbered list after it, or nothing).
      for (const heading of config.hideSections ?? []) {
        text = text.replace(new RegExp(`^## ${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\r?\\n(?:\\r?\\n|\\d+\\.[^\\n]*\\r?\\n)*`, "m"), "");
      }
      const html = headingIds(diagramsFromSource(marked.parse(text, { async: false }), file)).replace(/<a href="([^"#:]*)(#[^"]*)?">([\s\S]*?)<\/a>/g, (whole, target, hash = "", label) => {
        if (!target) return whole;
        const linked = path.normalize(path.join(path.dirname(file), target)).replace(/\/$/, "");
        const page = pageOf.get(linked) ?? pageOf.get(`${linked}/README.md`);
        // A repo file the guide doesn't show: keep the text, name the file.
        return page ? `<a href="${page}${hash}">${label}</a>` : `<span title="${linked}">${label}</span>`;
      });
      return [file, html];
    }),
  );
}

/** Review notes must point at a changed file and, if anchored, at a line in its diff. */
function checkNotes(pageList, branchList) {
  const problems = [];
  const kinds = new Set((config.annotationKinds ?? []).map((k) => k.id));
  for (const page of pageList) {
    const html = fs.readFileSync(path.join(GUIDE, page.path), "utf8");
    for (const match of html.matchAll(/<review-notes branch="([^"]+)">\s*<script type="application\/yaml">([\s\S]*?)<\/script>/g)) {
      const branch = branchList.find((b) => b.name === match[1]);
      const notes = YAML.parse(match[2]) ?? [];
      for (const note of notes) {
        const where = `${page.path}: ${note.file ?? "(no file)"}`;
        if (!kinds.has(note.kind)) problems.push(`${where}: unknown kind '${note.kind}'`);
        if (!branch) {
          problems.push(`${page.path}: unknown branch ${match[1]}`);
          continue;
        }
        if (!note.file) continue;
        const file = branch.files.find((f) => f.file === note.file);
        if (!file) {
          problems.push(`${where}: file not changed in ${branch.name}`);
          continue;
        }
        // Same rule as the renderer: match the line's text without its +/-/space prefix.
        if (note.at && !file.hunks.some((h) => h.lines.some((l) => l.slice(1).includes(note.at)))) {
          problems.push(`${where}: no diff line contains ${JSON.stringify(note.at)}`);
        }
      }
    }
  }
  return problems;
}

/** Line spans of fn/function definitions in the branch's version of a file (brace matched). */
function symbolSpans(ref, file) {
  if (!/\.(rs|ts|tsx|js|mjs)$/.test(file)) return {};
  let text;
  try {
    text = git("show", `${ref}:${file}`);
  } catch {
    return {};
  }
  const lines = text.split("\n");
  const spans = {};
  const defRe = /\b(?:fn|function)\s+([A-Za-z_][\w]*)|\b(?:const|let)\s+([A-Za-z_][\w]*)\s*=\s*(?:async\s*)?\(/;
  lines.forEach((line, i) => {
    const m = line.match(defRe);
    if (!m) return;
    const name = m[1] ?? m[2];
    let depth = 0;
    let opened = false;
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]) {
        if (ch === "{") {
          depth++;
          opened = true;
        } else if (ch === "}") depth--;
      }
      if (opened && depth <= 0) {
        (spans[name] ??= []).push([i + 1, j + 1]);
        return;
      }
      if (!opened && lines[j].trimEnd().endsWith(";")) return;
    }
  });
  return spans;
}

function parseHunks(patch) {
  const hunks = [];
  let current = null;
  for (const line of patch.split("\n")) {
    const header = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/);
    if (header) {
      current = { oldStart: Number(header[1]), newStart: Number(header[2]), context: header[3], lines: [] };
      hunks.push(current);
    } else if (current && /^[ +\-\\]/.test(line)) {
      current.lines.push(line);
    }
  }
  return hunks;
}
