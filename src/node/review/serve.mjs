// `in-ctrl review serve HOST:PORT…`: the review as the reader sees it. Serves
// the published build (`live`, a link to one of `releases/*`, swapped at once
// by `in-ctrl review publish`) and the review's API. Editing the pages never
// changes what's served; a page notices a new release and offers a reload.
//
// Only listens on the addresses given (localhost, a private network), never
// on every interface by default.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { reviewApi } from "./api.mjs";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

/** Serve the published review of `project` on each "host:port"; returns the servers. */
export function serveReview(project, addresses) {
  const live = path.join(project.root, "live");
  const releases = path.join(project.root, "releases");
  const version = () => liveVersion(live);
  const api = reviewApi(project, { version });
  // A new release is a new `live` link.
  fs.watch(project.root, (_event, name) => name === "live" && api.changed());
  const handle = (req, res) => {
    if (!api.handle(req, res)) serveStatic(req, res, live, releases);
  };
  return addresses.map((address) => {
    const at = address.lastIndexOf(":");
    const [host, port] = [address.slice(0, at), Number(address.slice(at + 1))];
    const server = http.createServer(handle);
    server.listen(port, host, () => {
      const { port: bound } = server.address();
      console.log(`review on http://${host}:${bound}/ (release ${version()})`);
    });
    return server;
  });
}

// Helpers

function liveVersion(live) {
  try {
    return path.basename(fs.realpathSync(live));
  } catch {
    return "none";
  }
}

function serveStatic(req, res, live, releases) {
  let pathname = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
  if (pathname.endsWith("/")) pathname += "index.html";
  // Hashed assets can come from an older release: a page loaded before a swap
  // still asks for the chunks it was built with.
  const roots = pathname.startsWith("/assets/") ? [live, ...olderReleases(releases)] : [live];
  for (const root of roots) {
    const file = path.join(root, pathname);
    if (!file.startsWith(root + path.sep)) break;
    try {
      const body = fs.readFileSync(file);
      res.setHeader("Content-Type", TYPES[path.extname(file)] ?? "application/octet-stream");
      res.setHeader("Cache-Control", pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
      return res.end(body);
    } catch {
      // Try the next release.
    }
  }
  res.statusCode = 404;
  res.end("Not found");
}

function olderReleases(releases) {
  try {
    return fs
      .readdirSync(releases)
      .sort()
      .reverse()
      .map((name) => path.join(releases, name));
  } catch {
    return [];
  }
}
