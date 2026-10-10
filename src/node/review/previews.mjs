// The docs site as a branch changes it, before and after, for reviewing docs
// as pages. For each unmerged stack branch that changes docs (and each in
// review.docPreviews: branch → the ref it is compared with), builds the
// repository's docs site with in-ctrl at both commits into previews/<commit>/,
// served at /previews/<commit>/ (publishing links them into each release). A
// commit is built once. Writes generated/previews.json: per branch, the two
// site roots and the pages that changed.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../bin/in-ctrl.mjs");

/** Build the previews `project`'s branches need (after `generate`, which lists the branches). */
export function buildPreviews(project) {
  const config = project.review;
  const GUIDE = project.root;
  const OUT = path.join(GUIDE, "previews");
  const git = (...args) => execFileSync("git", args, { cwd: config.repo, encoding: "utf8" }).trim();

  /** The site of one commit, built once; its root URL. */
  function site(sha) {
    const dir = path.join(OUT, sha);
    if (!fs.existsSync(path.join(dir, "index.html"))) {
      const src = fs.mkdtempSync(path.join(os.tmpdir(), "guide-preview-"));
      execFileSync("sh", ["-c", `git archive ${sha} | tar -x -C "${src}"`], { cwd: config.repo });
      // Served under the guide, not at the project's own base.
      const cfg = path.join(src, "in-ctrl.config.yaml");
      fs.writeFileSync(cfg, fs.readFileSync(cfg, "utf8").replace(/^(\s*base:).*$/m, `$1 /previews/${sha}/`));
      fs.rmSync(`${dir}.tmp`, { recursive: true, force: true });
      // review.previewTool: another in-ctrl to build them with (an npx spec), e.g. the version the docs pin.
      const tool = config.previewTool ? ["npx", ["--yes", config.previewTool]] : [process.execPath, [BIN]];
      execFileSync(tool[0], [...tool[1], "site", "build", `${dir}.tmp`, "--root", src], { stdio: ["ignore", "ignore", "inherit"] });
      fs.renameSync(`${dir}.tmp`, dir);
      fs.rmSync(src, { recursive: true, force: true });
      console.log(`preview built: ${sha.slice(0, 8)}`);
    }
    return `/previews/${sha}/`;
  }

  /** The site path of a doc: docs/guide/x.md → guide/x/, a folder's README.md → the folder, the home README → "". */
  function pagePath(file) {
    if (file === "README.md") return "";
    if (!file.startsWith("docs/") || !file.endsWith(".md")) return null;
    const rel = file.slice("docs/".length, -".md".length);
    return `${rel.replace(/(^|\/)README$/, "").replace(/\/$/, "")}/`.replace(/^\/$/, "");
  }

  // Every unmerged stack branch that changes docs, against its parent (from
  // gen-data.mjs, which runs first), plus the branches listed in docPreviews.
  const wanted = { ...(config.docPreviews ?? {}) };
  const index = JSON.parse(fs.readFileSync(path.join(GUIDE, "generated", "branches", "index.json"), "utf8"));
  for (const b of index) {
    if (b.merged || !b.name.startsWith(config.branchPrefix) || wanted[b.name]) continue;
    if (b.files.some((f) => f.file === "README.md" || (f.file.startsWith("docs/") && f.file.endsWith(".md")))) wanted[b.name] = b.parent;
  }
  const previews = {};
  for (const [branch, base] of Object.entries(wanted)) {
    const [after, before] = [git("rev-parse", branch), git("rev-parse", base)];
    const pages = git("diff", "--name-only", before, after, "--", "README.md", "docs")
      .split("\n")
      .filter(Boolean)
      .map((file) => ({ file, path: pagePath(file) }))
      .filter((p) => p.path !== null);
    previews[branch] = { base, before: site(before), after: site(after), pages };
  }
  fs.mkdirSync(path.join(GUIDE, "generated"), { recursive: true });
  fs.writeFileSync(path.join(GUIDE, "generated", "previews.json"), `${JSON.stringify(previews, null, 2)}\n`);

  // Builds no branch uses any more go.
  const used = new Set(Object.values(previews).flatMap((p) => [p.before, p.after].map((u) => u.split("/")[2])));
  for (const name of fs.existsSync(OUT) ? fs.readdirSync(OUT) : []) if (!used.has(name)) fs.rmSync(path.join(OUT, name), { recursive: true, force: true });
}
