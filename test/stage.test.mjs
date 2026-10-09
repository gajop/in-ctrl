import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/node/config.mjs";
import { stage } from "../src/node/stage.mjs";

function project(files, config = "repo: https://github.com/me/proj\n") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "in-ctrl-"));
  fs.writeFileSync(path.join(root, "in-ctrl.config.yaml"), config);
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  }
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "in-ctrl-out-"));
  const assets = fs.mkdtempSync(path.join(os.tmpdir(), "in-ctrl-assets-"));
  const groups = stage(loadConfig(root), out, assets);
  const read = (p) => fs.readFileSync(path.join(out, p), "utf8");
  return { root, out, assets, groups, read };
}

test("the first heading becomes the title, and READMEs become folder pages", () => {
  const { read, groups } = project({
    "README.md": "# Proj\n\nHello.\n",
    "docs/guide/README.md": "# Guide\n\nStart here.\n",
    "docs/guide/install.md": "# Install it\n\nRun it.\n",
  });
  assert.match(read("index.md"), /title: "Proj"/);
  assert.match(read("index.md"), /template: splash/);
  assert.match(read("guide/index.md"), /title: "Guide"/);
  assert.match(read("guide/install.md"), /^---\ntitle: "Install it"/);
  assert.doesNotMatch(read("guide/install.md"), /# Install it/);
  assert.deepEqual(groups, ["guide"]);
});

test("links to docs become site links; links to code go to GitHub", () => {
  const { read } = project({
    "docs/a.md": "# A\n\nSee [b](b.md#part), [the code](../src/main.rs) and [the guide](guide/).\n",
    "docs/b.md": "# B\n",
    "docs/guide/README.md": "# Guide\n",
    "src/main.rs": "fn main() {}\n",
  });
  const a = read("a.md");
  assert.match(a, /\[b\]\(\/b\/#part\)/);
  assert.match(a, /\[the code\]\(https:\/\/github.com\/me\/proj\/blob\/main\/src\/main.rs\)/);
  assert.match(a, /\[the guide\]\(\/guide\/\)/);
  assert.match(a, /editUrl: "https:\/\/github.com\/me\/proj\/edit\/main\/docs\/a.md"/);
});

test("a diagram's PNG becomes a live diagram; other images are copied", () => {
  const { read, assets } = project({
    "docs/a.md": "# A\n\n![The map](diagrams/map.png)\n\n![A photo](photo.png)\n",
    "docs/diagrams/map.diagram.yaml": "nodes: []\n",
    "docs/diagrams/map.png": "png",
    "docs/photo.png": "png",
  });
  const a = read("a.md");
  assert.match(a, /<div class="in-ctrl-diagram" data-file="docs\/diagrams\/map.diagram.yaml"/);
  assert.match(a, /<figcaption>The map<\/figcaption>/);
  assert.match(a, /!\[A photo\]\(\/_docs-assets\/photo.png\)/);
  assert.ok(fs.existsSync(path.join(assets, "photo.png")));
});

test("a top-level INDEX.md becomes /contents/, and the base path is kept", () => {
  const { read } = project({ "docs/INDEX.md": "# Index\n\n[a](a.md)\n", "docs/a.md": "# A\n" }, "site: { base: /proj/ }\n");
  assert.match(read("contents.md"), /\[a\]\(\/proj\/a\/\)/);
});

test("asset-only folders do not become empty sidebar groups", () => {
  const { groups } = project({
    "docs/start.md": "# Start here\n",
    "docs/images/photo.png": "png",
    "docs/reports/data/capture.json": "{}",
    "docs/ai/living/current.md": "# Current AI\n",
  });
  assert.deepEqual(groups, ["ai"]);
});
