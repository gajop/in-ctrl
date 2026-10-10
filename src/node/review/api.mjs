// The review's API, on the dev server and on `in-ctrl review serve`:
//   /_in-ctrl/comments         the review and the comments (src/node/comments.mjs)
//   /_in-ctrl/inbox            requests to the agent (inbox.mjs)
//   /_in-ctrl/version          the published release the server shows
//   /_in-ctrl/events           a stream that says when any of these changed,
//                              so pages hear it at once instead of polling

import fs from "node:fs";
import { commentsApi, watchComments } from "../comments.mjs";
import { inboxApi } from "./inbox.mjs";

/** `version()`: the release being served (none under the dev server). Returns { handle, changed, close }. */
export function reviewApi(project, { version = () => "dev" } = {}) {
  const comments = commentsApi({ ...project, base: "/" }, { sourceOf: () => undefined });
  const inbox = inboxApi(project.review.inbox);
  const listeners = new Set();
  let pending = null;
  const changed = () => {
    clearTimeout(pending);
    pending = setTimeout(() => {
      for (const res of listeners) res.write("data: changed\n\n");
    }, 100);
  };
  const stopComments = watchComments(comments.file, changed);
  const onInbox = (now, before) => now.mtimeMs !== before.mtimeMs && changed();
  fs.watchFile(project.review.inbox, { interval: 500 }, onInbox);
  const keepAlive = setInterval(() => {
    for (const res of listeners) res.write(": keep-alive\n\n");
  }, 25_000);
  keepAlive.unref?.();

  const handle = (req, res) => {
    if (comments.handle(req, res) || inbox(req, res)) return true;
    const url = req.url?.split("?")[0];
    if (url === "/_in-ctrl/version") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ version: version() }));
      return true;
    }
    if (url === "/_in-ctrl/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      res.write(": connected\n\n");
      listeners.add(res);
      req.on("close", () => listeners.delete(res));
      return true;
    }
    return false;
  };
  const close = () => {
    clearTimeout(pending);
    clearInterval(keepAlive);
    stopComments();
    fs.unwatchFile(project.review.inbox, onInbox);
    comments.close();
    for (const res of listeners) res.end();
    listeners.clear();
  };
  return { handle, changed, close };
}
