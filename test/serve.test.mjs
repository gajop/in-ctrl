import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseRedirects, redirectFor, writeRedirectPages } from "../src/node/redirects.mjs";
import { siteHandler } from "../src/node/serve.mjs";

function site() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "in-ctrl-serve-test-"));
  const put = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  put("index.html", "<h1>home</h1>");
  put("404.html", "<h1>themed 404</h1>");
  put("guides/using/index.html", "<h1>using</h1>");
  put("guides/using/checkout/index.html", "<h1>checkout</h1>");
  put("style.css", "body{}");
  put("clip.mp4", Buffer.from(Array.from({ length: 32 }, (_, i) => i)));
  put("clip.webm", "webm bytes");
  put("empty.mp4", "");
  fs.writeFileSync(path.join(os.tmpdir(), "in-ctrl-secret.txt"), "secret");
  return dir;
}

async function serve(dir, options) {
  const server = http.createServer(siteHandler(dir, options));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p, { method = "GET", headers = {} } = {}) =>
    new Promise((resolve, reject) => {
      // Raw paths, so "../" reaches the server as typed.
      const request = http.request({ host: "127.0.0.1", port: server.address().port, path: p, method, headers }, (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          const bytes = Buffer.concat(chunks);
          resolve({ status: res.statusCode, headers: res.headers, body: bytes.toString("utf8"), bytes });
        });
        res.on("error", reject);
      });
      request.on("error", reject);
      request.end();
    });
  return { server, base, get };
}

test("redirect rules: exact and folder rules, exact wins, slashes optional", () => {
  const rules = parseRedirects({ "/handbook/using/*": "/handbook/guides/using/*", "handbook/faq": "/handbook/guides/faq/", "/handbook/using/old/": "/handbook/x/" });
  assert.equal(redirectFor(rules, "/handbook/using/"), "/handbook/guides/using/");
  assert.equal(redirectFor(rules, "/handbook/using/checkout"), "/handbook/guides/using/checkout/");
  assert.equal(redirectFor(rules, "/handbook/using/old/"), "/handbook/x/");
  assert.equal(redirectFor(rules, "/handbook/faq"), "/handbook/guides/faq/");
  assert.equal(redirectFor(rules, "/handbook/other/"), null);
  assert.deepEqual(parseRedirects(undefined), []);
  assert.throws(() => parseRedirects({ "/a/*": "/b/" }), /ends in \*/);
  assert.throws(() => parseRedirects(["/a/"]), /map/);
});

test("serve: video MIME and byte ranges return exactly the requested bytes", async () => {
  const dir = site();
  const bytes = fs.readFileSync(path.join(dir, "clip.mp4"));
  const { server, get } = await serve(dir);
  try {
    const full = await get("/clip.mp4");
    assert.equal(full.status, 200);
    assert.equal(full.headers["content-type"], "video/mp4");
    assert.equal(full.headers["accept-ranges"], "bytes");
    assert.equal(full.headers["content-length"], "32");
    assert.deepEqual(full.bytes, bytes);
    assert.equal((await get("/clip.webm")).headers["content-type"], "video/webm");

    for (const [range, start, end] of [
      ["bytes=0-3", 0, 3], ["bytes=5-", 5, 31], ["bytes=-5", 27, 31],
      ["bytes=20-99", 20, 31], ["bytes=-999", 0, 31], ["Bytes=1-1", 1, 1],
      ["bytes=0001-0003", 1, 3], ["bytes=0-999999999999999999999999", 0, 31],
    ]) {
      const part = await get("/clip.mp4", { headers: { range } });
      assert.equal(part.status, 206, range);
      assert.equal(part.headers["content-type"], "video/mp4", range);
      assert.equal(part.headers["accept-ranges"], "bytes", range);
      assert.equal(part.headers["content-range"], `bytes ${start}-${end}/32`, range);
      assert.equal(part.headers["content-length"], String(end - start + 1), range);
      assert.deepEqual(part.bytes, bytes.subarray(start, end + 1), range);
    }
    const webm = await get("/clip.webm", { headers: { range: "bytes=1-4" } });
    assert.equal(webm.status, 206);
    assert.equal(webm.headers["content-type"], "video/webm");
    assert.equal(webm.body, "ebm ");
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("serve: HEAD, unsatisfiable ranges and unsupported forms keep HTTP semantics", async () => {
  const dir = site();
  const bytes = fs.readFileSync(path.join(dir, "clip.mp4"));
  const { server, get } = await serve(dir, { base: "/shop/" });
  try {
    // Range is a GET modifier, not a HEAD modifier (RFC 9110 section 14.2).
    for (const range of [undefined, "bytes=0-3", "bytes=99-"]) {
      const head = await get("/shop/clip.mp4", { method: "HEAD", headers: range ? { range } : {} });
      assert.equal(head.status, 200);
      assert.equal(head.headers["content-type"], "video/mp4");
      assert.equal(head.headers["content-length"], "32");
      assert.equal(head.headers["accept-ranges"], "bytes");
      assert.equal(head.headers["content-range"], undefined);
      assert.equal(head.bytes.length, 0);
    }
    for (const range of ["bytes=32-", "bytes=33-99", "bytes=9-3", "bytes=-0", "bytes=999999999999999999999-"]) {
      const response = await get("/shop/clip.mp4", { headers: { range } });
      assert.equal(response.status, 416, range);
      assert.equal(response.headers["content-range"], "bytes */32", range);
      assert.equal(response.headers["content-length"], "0", range);
      assert.equal(response.bytes.length, 0, range);
    }
    const empty = await get("/shop/empty.mp4", { headers: { range: "bytes=0-0" } });
    assert.equal(empty.status, 416);
    assert.equal(empty.headers["content-range"], "bytes */0");
    for (const range of ["items=0-3", "bytes=bad", "bytes=-", "bytes=0-1,4-5"]) {
      const response = await get("/shop/clip.mp4", { headers: { range } });
      assert.equal(response.status, 200, range);
      assert.equal(response.headers["content-range"], undefined, range);
      assert.deepEqual(response.bytes, bytes, range);
    }
    for (const validator of ['"unverified"', "Wed, 21 Oct 2015 07:28:00 GMT", ""]) {
      const unverified = await get("/shop/clip.mp4", { headers: { range: "bytes=0-3", "if-range": validator } });
      assert.equal(unverified.status, 200);
      assert.deepEqual(unverified.bytes, bytes);
    }
    const missing = await get("/shop/missing", { headers: { range: "bytes=0-3" } });
    assert.equal(missing.status, 404);
    assert.equal(missing.body, "<h1>themed 404</h1>");
    const post = await get("/shop/clip.mp4", { method: "POST", headers: { range: "bytes=0-3" } });
    assert.equal(post.status, 405);
    assert.equal(post.headers.allow, "GET, HEAD");
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("serve: pages, folders, MIME types, themed 404, no way out of the folder, redirects", async () => {
  const dir = site();
  const { server, get } = await serve(dir, { base: "/", redirects: parseRedirects({ "/using/*": "/guides/using/*" }) });
  try {
    const home = await get("/");
    assert.equal(home.status, 200);
    assert.match(home.headers["content-type"], /text\/html/);
    assert.equal((await get("/style.css")).headers["content-type"], "text/css; charset=utf-8");
    assert.equal((await get("/guides/using/")).body, "<h1>using</h1>");
    const bare = await get("/guides/using");
    assert.equal(bare.status, 301);
    assert.equal(bare.headers.location, "/guides/using/");
    const missing = await get("/no/such/page/");
    assert.equal(missing.status, 404);
    assert.equal(missing.body, "<h1>themed 404</h1>");
    for (const p of ["/../in-ctrl-secret.txt", "/..%2fin-ctrl-secret.txt", "/%2e%2e/in-ctrl-secret.txt", "/%00"]) {
      const r = await get(p);
      assert.equal(r.status, 404, p);
      assert.doesNotMatch(r.body, /secret/, p);
    }
    const moved = await get("/using/checkout/?x=1");
    assert.equal(moved.status, 302);
    assert.equal(moved.headers.location, "/guides/using/checkout/?x=1");
  } finally {
    server.close();
  }
});

test("serve under a base path", async () => {
  const dir = site();
  const { server, get } = await serve(dir, { base: "/shop/", redirects: parseRedirects({ "/using/*": "/guides/using/*" }) });
  try {
    assert.equal((await get("/shop/")).status, 200);
    assert.equal((await get("/")).status, 404);
    assert.equal((await get("/shop/using/")).headers.location, "/shop/guides/using/");
  } finally {
    server.close();
  }
});

test("build: a redirect page per moved page, never over an existing page", () => {
  const dir = site();
  const rules = parseRedirects({ "/using/*": "/guides/using/*", "/guides/using/": "/elsewhere/", "/old-home/": "/" });
  const written = writeRedirectPages(rules, dir, "/shop/");
  assert.deepEqual(written.sort(), ["/old-home/", "/using/", "/using/checkout/"]);
  const page = fs.readFileSync(path.join(dir, "using/checkout/index.html"), "utf8");
  assert.match(page, /url=\/shop\/guides\/using\/checkout\//);
  assert.equal(fs.readFileSync(path.join(dir, "guides/using/index.html"), "utf8"), "<h1>using</h1>");
});

test("serve: a path the build left a redirect page at answers with a 302; a real page at a redirected path is kept", async () => {
  const dir = site();
  const rules = parseRedirects({ "/using/*": "/guides/using/*", "/guides/using/": "/elsewhere/" });
  writeRedirectPages(rules, dir, "/");
  const { server, get } = await serve(dir, { base: "/", redirects: rules });
  try {
    const moved = await get("/using/checkout/");
    assert.equal(moved.status, 302);
    assert.equal(moved.headers.location, "/guides/using/checkout/");
    const real = await get("/guides/using/");
    assert.equal(real.status, 200);
    assert.equal(real.body, "<h1>using</h1>");
  } finally {
    server.close();
  }
});

test("config: site.redirects become rules", async () => {
  const { loadConfig } = await import("../src/node/config.mjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "in-ctrl-config-test-"));
  fs.writeFileSync(path.join(root, "in-ctrl.config.yaml"), "site:\n  redirects:\n    /a/*: /b/*\n    /c: /d/\n");
  assert.deepEqual(loadConfig(root).redirects, [
    { from: "/a/", to: "/b/", prefix: true },
    { from: "/c/", to: "/d/", prefix: false },
  ]);
  fs.writeFileSync(path.join(root, "in-ctrl.config.yaml"), "title: x\n");
  assert.deepEqual(loadConfig(root).redirects, []);
});
