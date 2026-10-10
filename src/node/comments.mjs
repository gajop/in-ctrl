// Comments on the docs site's pages and on the review (`in-ctrl review`):
// one JSON file in the project (config.comments, default
// .in-ctrl/comments.json, out of git), so every device sees the same threads
// and an agent can read them and reply from a shell (`in-ctrl comments`).
// `site dev`, `site serve` and the review's servers answer the API.
//
// The file holds collections of items by id; a change is a list of ops
// `{coll, id, value}` (value null deletes), so two devices editing different
// items never overwrite each other.
//
//   comments: id → { id, page?, file?, anchor?, text, created, edited?, author?, thread,
//                    branch?, line?, startLine?, side?, code? }
//     on a page: `page` and the `anchor` block on it (`file`: the page's Markdown);
//     on code under review: `branch`, its `file`, and `line` (or none: the whole file)
//   resolved: thread key → true
//   reviewed: "branch|file|patch hash" → true (a file of a branch, reviewed)
//   reviews: branch → { verdict: "approve" | "request-changes" | "comment" | null, summary, updated? }
//   marks: "page#section" → "good" | "needs-work"

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pagesOf, routeOf } from "./stage.mjs";

export const COLLECTIONS = ["comments", "resolved", "reviewed", "reviews", "marks"];
/** The site route the API lives under, after the site's base. */
export const API = "_in-ctrl/comments";

export function readComments(file) {
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  for (const coll of COLLECTIONS) state[coll] ??= {};
  return state;
}

/** Apply ops and save; returns the new state. */
export function applyOps(file, ops, { sourceOf = () => undefined } = {}) {
  if (!Array.isArray(ops)) throw new Error("expected a list of ops");
  const state = readComments(file);
  for (const { coll, id, value } of ops) {
    if (!COLLECTIONS.includes(coll) || typeof id !== "string" || !id) throw new Error(`bad op: ${JSON.stringify({ coll, id })}`);
    if (value === null || value === undefined) delete state[coll][id];
    else if (coll === "comments") state[coll][id] = withSource(value, id, sourceOf);
    else if (coll === "reviews") state[coll][id] = review(value, id);
    else if (coll === "marks") state[coll][id] = mark(value, id);
    else state[coll][id] = true;
  }
  write(file, state);
  return state;
}

/** Comments that answer each other share a thread key (comments saved before threads had ids are grouped by place). */
export function threadKey(c) {
  if (c.thread) return `t|${c.thread}`;
  if (c.anchor) return `page|${c.page}|${c.anchor.section}|${c.anchor.block}`;
  if (c.branch) return `code|${c.branch}|${c.file ?? ""}|${c.side ?? ""}|${c.line ?? ""}`;
  return `t|${c.id}`;
}

/** Every comment, oldest first. */
export function commentList(state) {
  return Object.values(state.comments).sort((a, b) => a.created.localeCompare(b.created));
}

/** An answer in the thread of comment `id` (or an id prefix), signed `author`. */
export function reply(file, id, text, author = "agent") {
  const state = readComments(file);
  const hits = commentList(state).filter((c) => c.id.startsWith(id));
  if (hits.length !== 1) throw new Error(`${hits.length} comments match ${id}`);
  if (!text.trim()) throw new Error("a reply needs a text");
  const target = hits[0];
  const { page, file: source, anchor, branch, line, startLine, side, code } = target;
  const value = {
    id: crypto.randomUUID(),
    page,
    file: source,
    anchor,
    branch,
    line,
    startLine,
    side,
    code,
    thread: target.thread ?? target.id,
    text: text.trim(),
    author,
    created: new Date().toISOString(),
  };
  applyOps(file, [{ coll: "comments", id: value.id, value }]);
  return value;
}

/** The threads as Markdown, by page or branch (open ones, or all with `includeResolved`), with each branch's verdict and the section marks. */
export function report(state, { includeResolved = false } = {}) {
  const threads = new Map();
  for (const c of commentList(state)) {
    const key = threadKey(c);
    if (!includeResolved && state.resolved[key]) continue;
    threads.set(key, [...(threads.get(key) ?? []), c]);
  }
  const targets = new Map();
  const add = (target, item) => targets.set(target, [...(targets.get(target) ?? []), item]);
  for (const [branch, r] of Object.entries(state.reviews)) {
    add(branch, `**Verdict: ${r.verdict ?? "none"}**${r.summary?.trim() ? `\n\n${r.summary.trim()}` : ""}`);
  }
  for (const [key, value] of Object.entries(state.marks)) {
    const [page, section] = key.split("#");
    add(page, `- Section \`${section}\`: ${value === "good" ? "looks good" : "**needs work**"}`);
  }
  for (const [key, list] of threads) {
    const first = list[0];
    const a = first.anchor;
    const where = a
      ? `"${a.sectionTitle ?? ""}"${a.block === "heading" ? " (section)" : ""}${a.about ? `, about ${a.about}` : ""}${a.block !== "heading" && a.quote ? `\n  > ${a.quote}` : ""}`
      : first.file
        ? `\`${first.file}${first.line ? `:${first.startLine && first.startLine !== first.line ? `${first.startLine}-` : ""}${first.line}` : ""}\`${first.side === "old" ? " (removed line)" : ""}${first.code ? `\n  > \`${first.code.trim()}\`` : ""}`
        : "general";
    const body = list
      .map((c) => `  - ${c.author ?? "reader"} [${c.id.slice(0, 8)}]: ${c.text.trim().replace(/\n/g, "\n    ")}`)
      .join("\n");
    // A docs page: its Markdown file and route; a review page or code: its branch.
    const target = first.branch ?? (first.file ? `${first.file} (${first.page})` : first.page ?? "general");
    add(target, `- ${where}${state.resolved[key] ? " (resolved)" : ""}\n${body}`);
  }
  if (!targets.size) return includeResolved ? "No comments." : "No open comments.";
  return [...targets].map(([target, items]) => `## ${target}\n\n${items.join("\n")}`).join("\n\n");
}

/** Maps a page route to its Markdown source, relative to the project root. */
export function sourceResolver(config) {
  let routes = null;
  return (page) => {
    routes ??= new Map([...pagesOf(config)].map(([source, slug]) => [routeOf(config, slug), path.relative(config.root, source).replace(/\\/g, "/")]));
    const found = routes.get(page);
    if (!found) routes = null; // a page added since: look again next time
    return found;
  };
}

/** The most a POST may carry. */
const MAX_BODY = 1 << 20;

/**
 * The comments API for a server: GET and POST {base}_in-ctrl/comments, and
 * {base}_in-ctrl/comments/events, a stream that says when the file changed
 * (a reply from a shell, another device). `sourceOf` maps a page to its
 * Markdown source (default: the docs site's). `handle(req, res)` answers a request
 * and returns true if it was the API's; `changed()` tells the open streams;
 * `close()` ends them.
 */
export function commentsApi(config, { sourceOf = sourceResolver(config) } = {}) {
  const file = config.comments;
  const base = config.base.endsWith("/") ? config.base : `${config.base}/`;
  const route = `${base}${API}`;
  const listeners = new Set();
  const changed = () => {
    for (const res of listeners) res.write("data: changed\n\n");
  };
  const keepAlive = setInterval(() => {
    for (const res of listeners) res.write(": keep-alive\n\n");
  }, 25_000);
  keepAlive.unref?.();

  const send = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const handle = (req, res) => {
    const url = req.url?.split("?")[0];
    if (url === `${route}/events`) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      res.write(": connected\n\n");
      listeners.add(res);
      req.on("close", () => listeners.delete(res));
      return true;
    }
    if (url !== route) return false;
    if (req.method === "GET") {
      send(res, 200, readComments(file));
      return true;
    }
    if (req.method !== "POST") {
      send(res, 405, { error: "GET or POST" });
      return true;
    }
    let body = "";
    let tooBig = false;
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) tooBig = true;
    });
    req.on("end", () => {
      if (tooBig) return send(res, 413, { error: "too large" });
      try {
        const state = applyOps(file, JSON.parse(body), { sourceOf });
        send(res, 200, state);
        changed();
      } catch (err) {
        send(res, 400, { error: String(err.message ?? err) });
      }
    });
    return true;
  };
  const close = () => {
    clearInterval(keepAlive);
    for (const res of listeners) res.end();
    listeners.clear();
  };
  return { file, route, handle, changed, close };
}

/**
 * Follow the comments file for changes made outside this server (`in-ctrl
 * comments reply`, an editor). Polls, so it works before the file exists and
 * across the rename each save does. Returns a function that stops.
 */
export function watchComments(file, onChange, interval = 500) {
  const listener = (now, before) => {
    if (now.mtimeMs !== before.mtimeMs || now.size !== before.size) onChange();
  };
  fs.watchFile(file, { interval }, listener);
  return () => fs.unwatchFile(file, listener);
}

/** Vite plugin for `site dev`: the comments API on the dev server. */
export function commentsPlugin(config) {
  return {
    name: "in-ctrl-comments",
    apply: "serve",
    configureServer(server) {
      const api = commentsApi(config);
      const unwatch = watchComments(api.file, api.changed);
      server.httpServer?.once("close", () => {
        unwatch();
        api.close();
      });
      server.middlewares.use((req, res, next) => {
        if (!api.handle(req, res)) next();
      });
    },
  };
}

// Helpers

/** A comment as stored: only known fields, with a docs page's Markdown source filled in. */
function withSource(value, id, sourceOf) {
  if (typeof value !== "object" || value === null || typeof value.text !== "string" || (typeof value.page !== "string" && typeof value.branch !== "string")) {
    throw new Error(`bad comment ${id}: needs a page or a branch, and text`);
  }
  const { page, anchor, text, created, edited, author, branch, line, startLine, side, code } = value;
  const file = value.file ?? (branch ? undefined : sourceOf(page));
  return JSON.parse(
    JSON.stringify({ id, page, file, anchor, branch, line, startLine, side, code, text, created: created ?? new Date().toISOString(), edited, author, thread: value.thread ?? id }),
  );
}

const VERDICTS = ["approve", "request-changes", "comment", null];

/** A branch's review as stored: its verdict and summary. */
function review(value, id) {
  if (typeof value !== "object" || value === null || !VERDICTS.includes(value.verdict ?? null)) throw new Error(`bad review of ${id}`);
  const { verdict = null, summary = "", updated } = value;
  return JSON.parse(JSON.stringify({ verdict, summary: String(summary), updated }));
}

/** A section's mark. */
function mark(value, id) {
  if (value !== "good" && value !== "needs-work") throw new Error(`bad mark on ${id}: good or needs-work`);
  return value;
}

function write(file, state) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    // A folder made for the comments keeps them out of git.
    fs.writeFileSync(path.join(dir, ".gitignore"), "*\n");
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 1)}\n`);
  fs.renameSync(tmp, file);
}
