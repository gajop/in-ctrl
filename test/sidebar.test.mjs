import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { sidebarFor, labelOf } from "../src/node/sidebar.mjs";

function staged(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "in-ctrl-sidebar-"));
  for (const f of Array.isArray(files) ? files.map((f) => [f, "# x\n"]) : Object.entries(files)) {
    const [name, text] = f;
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  }
  return root;
}

test("folders listed by name keep Starlight's own A-to-Z listing", () => {
  const docs = staged(["guide/a.md", "dev/b.md"]);
  const sidebar = sidebarFor({ sidebar: [{ dir: "guide" }, { dir: "dev", label: "Developer docs" }] }, docs, ["dev", "guide"]);
  assert.deepEqual(sidebar, [
    { label: "Guide", items: [{ autogenerate: { directory: "guide" } }] },
    { label: "Developer docs", items: [{ autogenerate: { directory: "dev" } }] },
  ]);
});

test("nested groups take labels and order, the rest follow A to Z", () => {
  const docs = staged([
    "handbook/index.md",
    "handbook/guides/index.md",
    "handbook/guides/faq.md",
    "handbook/guides/using/daily.md",
    "handbook/articles/index.md",
    "handbook/articles/2026-10-03-old.md",
    "handbook/articles/2026-10-05-new.md",
    "handbook/background/pricing.md",
  ]);
  fs.mkdirSync(path.join(docs, "handbook/media"));
  const config = {
    sidebar: [{ dir: "handbook", label: "Handbook", items: [{ dir: "guides", label: "Guides" }, { dir: "articles", label: "Reports", order: "newest-first", collapsed: true }] }],
  };
  const [handbook] = sidebarFor(config, docs, ["handbook"]);
  assert.equal(handbook.label, "Handbook");
  assert.deepEqual(handbook.items[0], { slug: "handbook" });
  assert.deepEqual(handbook.items.slice(1).map((g) => g.label), ["Guides", "Reports", "Background"]);
  const [guides, reports, background] = handbook.items.slice(1);
  assert.deepEqual(guides.items, [{ slug: "handbook/guides" }, { slug: "handbook/guides/faq" }, { label: "Using", items: [{ slug: "handbook/guides/using/daily" }] }]);
  assert.equal(reports.collapsed, true);
  assert.deepEqual(reports.items, [{ slug: "handbook/articles" }, { slug: "handbook/articles/2026-10-05-new" }, { slug: "handbook/articles/2026-10-03-old" }]);
  assert.deepEqual(background.items, [{ slug: "handbook/background/pricing" }]);
});

test("a bad order is an error, and labels read as words", () => {
  const docs = staged(["a/x.md"]);
  assert.throws(() => sidebarFor({ sidebar: [{ dir: "a", order: "sideways" }] }, docs, ["a"]), /not one of/);
  assert.equal(labelOf("getting-started"), "Getting started");
});

test("newest-first lists numbered pages by number, pinned pages first, the rest Z to A", () => {
  const page = (front) => `---\ntitle: "x"\n${front}---\n`;
  const docs = staged({
    "r/index.md": page(""),
    "r/2026-10-03-first.md": page("number: 1\n"),
    // Added later than 2026-10-05-b, though its name sorts first.
    "r/2026-10-05-a.md": page("number: 3\n"),
    "r/2026-10-05-b.md": page("number: 2\n"),
    "r/2026-10-10-unnumbered.md": page(""),
    "r/2026-10-04-journal.md": page("pinned: true\n"),
  });
  const [r] = sidebarFor({ sidebar: [{ dir: "r", order: "newest-first" }] }, docs, ["r"]);
  assert.deepEqual(
    r.items.map((i) => i.slug),
    ["r", "r/2026-10-04-journal", "r/2026-10-05-a", "r/2026-10-05-b", "r/2026-10-03-first", "r/2026-10-10-unnumbered"],
  );
  const [az] = sidebarFor({ sidebar: [{ dir: "r", items: [] }] }, docs, ["r"]);
  assert.deepEqual(
    az.items.map((i) => i.slug),
    ["r", "r/2026-10-04-journal", "r/2026-10-03-first", "r/2026-10-05-a", "r/2026-10-05-b", "r/2026-10-10-unnumbered"],
  );
});
