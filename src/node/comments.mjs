// Comments on the docs site's pages, kept in one JSON file in the project
// (config.comments, default .in-ctrl/comments.json, out of git), so every
// device that opens the site sees the same threads and an agent can read
// them and reply from a shell (`in-ctrl comments`). Both `site dev` and
// `site serve` (a built site) answer the API.
//
// The file holds collections of items by id; a change is a list of ops
// `{coll, id, value}` (value null deletes), so two devices editing different
// items never overwrite each other.
//
//   comments: id → { id, page, file, anchor, text, created, edited?, author?, thread }
//   resolved: thread key → true

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pagesOf, routeOf } from "./stage.mjs";

export const COLLECTIONS = ["comments", "resolved"];
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
    else state[coll][id] = true;
  }
  write(file, state);
  return state;
}

/** Comments that answer each other share a thread key. */
export function threadKey(c) {
  return `t|${c.thread ?? c.id}`;
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
  const value = {
    id: crypto.randomUUID(),
    page: target.page,
    file: target.file,
    anchor: target.anchor,
    thread: target.thread ?? target.id,
    text: text.trim(),
    author,
    created: new Date().toISOString(),
  };
  applyOps(file, [{ coll: "comments", id: value.id, value }]);
  return value;
}

/** The threads as Markdown, by page: open ones, or all with `includeResolved`. */
export function report(state, { includeResolved = false } = {}) {
  const threads = new Map();
  for (const c of commentList(state)) {
    const key = threadKey(c);
    if (!includeResolved && state.resolved[key]) continue;
    threads.set(key, [...(threads.get(key) ?? []), c]);
  }
  const byPage = new Map();
  for (const [key, list] of threads) {
    const first = list[0];
    const target = first.file ? `${first.file} (${first.page})` : first.page;
    const a = first.anchor ?? {};
    const place = `"${a.sectionTitle ?? ""}"${a.block === "heading" ? " (section)" : ""}${a.about ? `, about ${a.about}` : ""}`;
    const quote = a.block !== "heading" && a.quote ? `\n  > ${a.quote}` : "";
    const body = list
      .map((c) => `  - ${c.author ?? "reader"} [${c.id.slice(0, 8)}]: ${c.text.trim().replace(/\n/g, "\n    ")}`)
      .join("\n");
    byPage.set(target, [...(byPage.get(target) ?? []), `- ${place}${state.resolved[key] ? " (resolved)" : ""}${quote}\n${body}`]);
  }
  if (!byPage.size) return includeResolved ? "No comments." : "No open comments.";
  return [...byPage].map(([target, items]) => `## ${target}\n\n${items.join("\n")}`).join("\n\n");
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
 * (a reply from a shell, another device). `handle(req, res)` answers a request
 * and returns true if it was the API's; `changed()` tells the open streams;
 * `close()` ends them.
 */
export function commentsApi(config) {
  const file = config.comments;
  const base = config.base.endsWith("/") ? config.base : `${config.base}/`;
  const route = `${base}${API}`;
  const sourceOf = sourceResolver(config);
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

/** A comment as stored: only known fields, with its Markdown source filled in. */
function withSource(value, id, sourceOf) {
  if (typeof value !== "object" || typeof value.text !== "string" || typeof value.page !== "string") {
    throw new Error(`bad comment ${id}: needs page and text`);
  }
  const { page, anchor, text, created, edited, author, thread } = value;
  const file = value.file ?? sourceOf(page);
  return JSON.parse(JSON.stringify({ id, page, file, anchor, text, created: created ?? new Date().toISOString(), edited, author, thread: thread ?? id }));
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
