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
  fs.writeFileSync(path.join(os.tmpdir(), "in-ctrl-secret.txt"), "secret");
  return dir;
}

async function serve(dir, options) {
  const server = http.createServer(siteHandler(dir, options));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p) =>
    new Promise((resolve, reject) => {
      // Raw paths, so "../" reaches the server as typed.
      http.get({ host: "127.0.0.1", port: server.address().port, path: p }, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }).on("error", reject);
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
