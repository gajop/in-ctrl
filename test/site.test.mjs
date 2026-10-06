import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import YAML from "yaml";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

function cli(root, args) {
  const child = spawn(process.execPath, [path.join(packageRoot, "bin/in-ctrl.mjs"), ...args, "--root", root], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => { output += data; });
  return { child, output: () => output };
}

test("built and live sites populate nested sidebars and initialize React before diagrams", { timeout: 60000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "in-ctrl-site-test-"));
  let dev;
  try {
    fs.cpSync(path.join(packageRoot, "test/fixture"), root, { recursive: true });
    const configPath = path.join(root, "in-ctrl.config.yaml");
    const config = YAML.parse(fs.readFileSync(configPath, "utf8"));
    config.site = { ...config.site, base: "/shop/", sidebar: [{ dir: "guides", label: "Guides" }] };
    fs.writeFileSync(configPath, YAML.stringify(config));
    fs.mkdirSync(path.join(root, "docs/guides/setup"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs/guides/README.md"), "# Guides\n");
    fs.writeFileSync(path.join(root, "docs/guides/setup/install.md"), "# Install\n");
    fs.mkdirSync(path.join(root, "docs/guides/notes"));
    fs.writeFileSync(path.join(root, "docs/guides/notes/2026-10-05-beta.md"), "---\nnumber: 2\nsidebar_label: Beta\n---\n# 2026-10-05 — Beta opens to everyone\n");
    fs.writeFileSync(path.join(root, "docs/guides/notes/2026-10-04-alpha.md"), "---\nnumber: 1\n---\n# Alpha\n");
    fs.mkdirSync(path.join(root, "docs/assets"));
    fs.writeFileSync(path.join(root, "docs/assets/example.json"), "{}");
    const out = path.join(root, "dist");
    const build = cli(root, ["site", "build", out]);
    const [code] = await once(build.child, "exit");
    assert.equal(code, 0, build.output());
    const html = fs.readFileSync(path.join(out, "architecture/index.html"), "utf8");
    for (const route of ["guides/", "guides/setup/install/"]) {
      assert.ok(html.includes(`href="/shop/${route}"`), `Missing built sidebar link: ${route}`);
    }
    assert.ok(!html.includes("<summary>Assets"), "Asset-only folder created an empty sidebar group");
    // Numbered pages: short labels in the sidebar, the full title on the page.
    assert.match(html, /<span[^>]*>\s*2 · Beta\s*<\/span>/);
    assert.match(html, /<span[^>]*>\s*1 · Alpha\s*<\/span>/);
    const beta = fs.readFileSync(path.join(out, "guides/notes/2026-10-05-beta/index.html"), "utf8");
    assert.match(beta, /<h1[^>]*>2026-10-05 — Beta opens to everyone<\/h1>/);
    assert.ok(!beta.includes("sidebar_label"), "front matter leaked into the page");

    dev = cli(root, ["site", "dev"]);
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Dev server did not start: ${dev.output()}`)), 20000);
      dev.child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Dev server exited (${code}): ${dev.output()}`));
      });
      dev.child.stdout.on("data", () => {
        const match = dev.output().match(/site on (http:\/\/localhost:\d+\/shop\/)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
    });
    const page = await fetch(new URL("architecture/", url));
    assert.equal(page.status, 200);
    const live = await page.text();
    assert.ok(live.includes('href="/shop/guides/setup/install/"'), "Missing live nested sidebar link");
    const script = [...live.matchAll(/<script[^>]*src="([^"]+)"/g)]
      .map((match) => match[1]).find((src) => src.includes("astro:scripts/page.js"));
    assert.ok(script, "Missing diagram bootstrap script");
    const bootstrapResponse = await fetch(new URL(script, url));
    assert.equal(bootstrapResponse.status, 200);
    const bootstrap = await bootstrapResponse.text();
    assert.match(bootstrap, /before-hydration\.js/);
    assert.match(bootstrap, /import\([^\n]*diagrams\.tsx/);
    assert.ok(bootstrap.indexOf("before-hydration.js") < bootstrap.indexOf("diagrams.tsx"),
      "React initialization must precede the dynamic diagram import");

    const eventually = async (route, predicate) => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const response = await fetch(new URL(route, url));
        const body = await response.text();
        if (predicate(response, body)) return body;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      assert.fail(`Live docs did not update ${route}: ${dev.output()}`);
    };
    const added = path.join(root, "docs/guides/setup/added.md");
    fs.writeFileSync(added, "# Added while serving\n\nLive addition marker.\n");
    await eventually("guides/setup/added/", (r, b) => r.status === 200 && b.includes("Live addition marker"));
    await eventually("architecture/", (r, b) => b.includes('href="/shop/guides/setup/added/"'));
    fs.writeFileSync(added, "# Edited while serving\n\nLive edit marker.\n");
    await eventually("guides/setup/added/", (r, b) => b.includes("Live edit marker") && !b.includes("Live addition marker"));
    fs.unlinkSync(added);
    await eventually("guides/setup/added/", (r) => r.status === 404);
    await eventually("architecture/", (r, b) => !b.includes('href="/shop/guides/setup/added/"'));

    // Projects without document subfolders use Starlight's root navigation.
    const flat = path.join(root, "flat");
    fs.mkdirSync(path.join(flat, "docs"), { recursive: true });
    fs.writeFileSync(path.join(flat, "in-ctrl.config.yaml"), "title: Flat docs\n");
    fs.writeFileSync(path.join(flat, "docs/README.md"), "# Flat docs\n");
    fs.writeFileSync(path.join(flat, "docs/start.md"), "# Start here\n");
    const flatOut = path.join(flat, "dist");
    const flatBuild = cli(flat, ["site", "build", flatOut]);
    const [flatCode] = await once(flatBuild.child, "exit");
    assert.equal(flatCode, 0, flatBuild.output());
    assert.ok(fs.readFileSync(path.join(flatOut, "start/index.html"), "utf8").includes('href="/start/" aria-current="page"'),
      "Root-only docs are missing their current-page sidebar link");
  } finally {
    if (dev && dev.child.exitCode === null) {
      const exited = once(dev.child, "exit");
      dev.child.kill("SIGTERM");
      await exited;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
