// `in-ctrl site serve`: a built site over HTTP with nothing but Node. Folders serve their
// index.html, moved pages answer with a 302 (site.redirects), and anything missing gets the
// site's own 404 page with status 404.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { REDIRECT_MARK, joinBase, redirectFor } from "./redirects.mjs";

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

  const send = (res, status, file, head = false) => {
    const type = TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
    res.writeHead(status, { "content-type": type, "content-length": fs.statSync(file).size });
    if (head) return res.end();
    fs.createReadStream(file).pipe(res);
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
      if (fs.existsSync(index)) return send(res, 200, index, head);
      stat = null;
    }
    if (stat?.isFile()) return send(res, 200, file, head);
    return missing(res, head);
  };
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
  const server = http.createServer(siteHandler(root, { base: config.base, redirects: config.redirects }));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  console.log(`site on http://${host}:${server.address().port}${config.base}`);
  return server;
}
