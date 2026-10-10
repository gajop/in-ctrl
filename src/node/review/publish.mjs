// `in-ctrl review build [DIR]` and `in-ctrl review publish`: the review as
// static files. Publishing builds a new release into releases/ and swaps the
// `live` link to it in one rename, so `in-ctrl review serve` never serves a
// half-built review; open pages notice the new version and offer a reload.
// The last five releases stay, so pages loaded before a swap still find
// their hashed chunks.

import fs from "node:fs";
import path from "node:path";
import { build } from "vite";
import { generate } from "./data.mjs";
import { buildPreviews } from "./previews.mjs";
import { viteConfig } from "./vite.mjs";

const KEEP = 5;

/** Build the review of `project` into `outDir`. */
export async function buildReview(project, outDir) {
  const config = viteConfig(project);
  await build({ ...config, build: { ...config.build, outDir: path.resolve(outDir), emptyOutDir: true } });
}

/** Generate the data, build a release, and make it the live one; returns its name. */
export async function publishReview(project) {
  if (generate(project)) throw new Error("the review's data has problems");
  buildPreviews(project);
  const releases = path.join(project.root, "releases");
  const name = stamp(new Date());
  const out = path.join(releases, name);
  await buildReview(project, out);
  // The docs-site previews: built once per commit, linked into every release.
  const previews = path.join(project.root, "previews");
  if (fs.existsSync(previews)) linkTree(previews, path.join(out, "previews"));
  const next = path.join(project.root, "live.next");
  fs.rmSync(next, { force: true });
  fs.symlinkSync(path.relative(project.root, out), next);
  fs.renameSync(next, path.join(project.root, "live"));
  for (const old of fs.readdirSync(releases).sort().slice(0, -KEEP)) fs.rmSync(path.join(releases, old), { recursive: true, force: true });
  return name;
}

// Helpers

/** 20261010-231342 */
function stamp(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** A copy of `from` at `to` made of hard links: no extra space, and later builds can't change it. */
function linkTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const [src, dst] = [path.join(from, entry.name), path.join(to, entry.name)];
    if (entry.isDirectory()) linkTree(src, dst);
    else fs.linkSync(src, dst);
  }
}
