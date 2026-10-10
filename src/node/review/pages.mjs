// `in-ctrl review pages`: a review page for each branch outside the stack
// (review.branches) that doesn't have one yet, in pages/review-dev: the
// commit message as its summary, and the code. Pages that exist are left
// alone, so they can be rewritten by hand.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { marked } from "marked";

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** Write the missing pages; returns the files written, relative to the project. */
export function writeBranchPages(project) {
  const config = project.review;
  const git = (...args) => execFileSync("git", args, { cwd: config.repo, encoding: "utf8" }).trim();
  const written = [];
  const dir = path.join(config.pages, "review-dev");
  fs.mkdirSync(dir, { recursive: true });
  (config.branches ?? []).forEach((b, i) => {
    const file = path.join(dir, `${b.name.replaceAll("/", "__")}.html`);
    if (fs.existsSync(file)) return;
    const [subject, ...rest] = git("log", "-1", "--format=%B", b.name).split("\n");
    const body = rest.filter((l) => !/^(Co-Authored-By|Claude-Session):/.test(l)).join("\n").trim();
    fs.writeFileSync(
      file,
      `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(b.name)} · ${esc(subject)}</title>
<meta name="guide:section" content="review">
<meta name="guide:order" content="${200 + i + 1}">
<meta name="guide:branch" content="${esc(b.name)}">
<meta name="guide:summary" content="${esc(subject)}">
</head>
<body>
<guide-nav></guide-nav>
<main>
<review-header branch="${esc(b.name)}"></review-header>

<div class="tldr">
<p class="muted">No review page written yet; this is the commit message.</p>
${marked.parse(body, { async: false })}
</div>

<h2 id="code">Code</h2>
<review-code branch="${esc(b.name)}"></review-code>
</main>
</body>
</html>
`,
    );
    written.push(path.relative(project.root, file));
  });
  return written;
}
