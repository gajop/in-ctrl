// `in-ctrl site serve`: a built site over HTTP with nothing but Node. Folders serve their
// index.html, moved pages answer with a 302 (site.redirects), and anything missing gets the
// site's own 404 page with status 404. With comments on (config.comments), it also answers
// the comments API (comments.mjs) against the project's comments file, so readers of the
// built site comment as they would on `site dev`.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { REDIRECT_MARK, joinBase, redirectFor } from "./redirects.mjs";
import { commentsApi, watchComments } from "./comments.mjs";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".pf_meta": "application/octet-stream",
  ".pf_index": "application/octet-stream",
  ".pf_fragment": "application/octet-stream",
  ".pagefind": "application/octet-stream",
};

/** A request handler for the site in `dir`, served under `base`, with redirect rules. */
export function siteHandler(dir, { base = "/", redirects = [] } = {}) {
  const root = path.resolve(dir);
  const prefix = base.replace(/\/+$/, "");
  const notFound = path.join(root, "404.html");

  const send = (res, status, file, head = false, range) => {
    const type = TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
    const size = fs.statSync(file).size;
    const headers = { "content-type": type, "content-length": size };
    if (status === 200) headers["accept-ranges"] = "bytes";
    const selected = status === 200 ? byteRange(range, size) : null;
    if (selected === false) {
      res.writeHead(416, { ...headers, "content-range": `bytes */${size}`, "content-length": 0 });
      return res.end();
    }
    if (selected) {
      status = 206;
      headers["content-range"] = `bytes ${selected.start}-${selected.end}/${size}`;
      headers["content-length"] = selected.end - selected.start + 1;
    }
    res.writeHead(status, headers);
    if (head) return res.end();
    const stream = fs.createReadStream(file, selected || undefined);
    res.once("close", () => stream.destroy());
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  };
  const missing = (res, head) => {
    if (fs.existsSync(notFound)) return send(res, 404, notFound, head);
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end(head ? undefined : "Not found\n");
  };

  return (req, res) => {
    const head = req.method === "HEAD";
    if (req.method !== "GET" && !head) {
      res.writeHead(405, { allow: "GET, HEAD" });
      return res.end();
    }
    // Range is defined for GET only. Without validators, If-Range cannot be
    // verified, so return the complete representation rather than a stale slice.
    const range = !head && req.headers["if-range"] === undefined ? req.headers.range : null;
    let url;
    try {
      url = new URL(req.url, "http://site");
    } catch {
      return missing(res, head);
    }
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return missing(res, head);
    }
    if (pathname.includes("\0")) return missing(res, head);
    if (prefix && !(pathname === prefix || pathname.startsWith(prefix + "/"))) return missing(res, head);
    const sitePath = pathname.slice(prefix.length) || "/";

    // Resolve inside the site folder only.
    const file = path.resolve(root, "." + path.posix.normalize("/" + sitePath));
    if (file !== root && !file.startsWith(root + path.sep)) return missing(res, head);

    // Moved pages: a 302, whether the build left a redirect page there or nothing at all.
    const to = redirectFor(redirects, sitePath);
    if (to && isRedirectOrMissing(file)) {
      res.writeHead(302, { location: joinBase(base, to) + url.search });
      return res.end();
    }

    let stat = fs.existsSync(file) ? fs.statSync(file) : null;
    if (stat?.isDirectory()) {
      if (!pathname.endsWith("/")) {
        res.writeHead(301, { location: pathname + "/" + url.search });
        return res.end();
      }
      const index = path.join(file, "index.html");
      if (fs.existsSync(index)) return send(res, 200, index, head, range);
      stat = null;
    }
    if (stat?.isFile()) return send(res, 200, file, head, range);
    return missing(res, head);
  };
}

/** One bounded byte slice, false for unsatisfiable, null to ignore unsupported syntax. */
function byteRange(value, size) {
  if (typeof value !== "string") return null;
  // Ignore multipart/unknown units instead of allocating or streaming many parts.
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return null;
  const length = BigInt(size);
  if (length === 0n) return false;
  let start, end;
  if (!match[1]) {
    const suffix = BigInt(match[2]);
    if (suffix === 0n) return false;
    start = suffix < length ? length - suffix : 0n;
    end = length - 1n;
  } else {
    start = BigInt(match[1]);
    end = match[2] ? BigInt(match[2]) : length - 1n;
    if (start >= length || end < start) return false;
    if (end >= length) end = length - 1n;
  }
  return { start: Number(start), end: Number(end) };
}

/** True if nothing is at `file`, or only a redirect page `site build` wrote. */
function isRedirectOrMissing(file) {
  if (!fs.existsSync(file)) return true;
  const page = fs.statSync(file).isDirectory() ? path.join(file, "index.html") : file;
  if (!fs.existsSync(page)) return true;
  const fd = fs.openSync(page, "r");
  try {
    const buf = Buffer.alloc(256);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString("utf8").includes(REDIRECT_MARK);
  } finally {
    fs.closeSync(fd);
  }
}

export async function serveSite(config, dir, { host = "127.0.0.1", port = 8080 } = {}) {
  const root = path.resolve(dir);
  if (!fs.existsSync(path.join(root, "index.html")) && !fs.existsSync(path.join(root, "404.html")))
    throw new Error(`in-ctrl: ${dir} doesn't look like a built site (run: in-ctrl site build ${dir})`);
  const site = siteHandler(root, { base: config.base, redirects: config.redirects });
  const api = config.comments ? commentsApi(config) : null;
  const unwatch = api ? watchComments(api.file, api.changed) : () => {};
  const server = http.createServer((req, res) => {
    if (api?.handle(req, res)) return;
    site(req, res);
  });
  // The comments' event streams never end on their own: end them so close() can finish.
  const close = server.close.bind(server);
  server.close = (callback) => {
    unwatch();
    api?.close();
    return close(callback);
  };
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  console.log(`site on http://${host}:${server.address().port}${config.base}`);
  if (api) console.log(`comments in ${api.file}`);
  return server;
}
