import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "playwright";
import { readComments } from "../src/node/comments.mjs";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

function cli(root, args) {
  const child = spawn(process.execPath, [path.join(packageRoot, "bin/in-ctrl.mjs"), ...args, "--root", root], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (data) => {
      output += data;
    });
  }
  return { child, output: () => output };
}

async function run(root, args) {
  const r = cli(root, args);
  const [code] = await once(r.child, "exit");
  assert.equal(code, 0, `in-ctrl ${args.join(" ")}: ${r.output()}`);
  return r.output();
}

/** A shop repository with a stack of two branches on main, and a review folder beside it. */
function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "in-ctrl-review-"));
  const repo = path.join(dir, "shop");
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  const put = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), text);
  };
  fs.mkdirSync(repo);
  git("init", "-q", "-b", "main");
  git("config", "user.email", "dev@example.com");
  git("config", "user.name", "Dev");
  put("src/cart.js", "export function total(items) {\n  return items.reduce((n, i) => n + i.price, 0);\n}\n");
  git("add", "-A");
  git("commit", "-qm", "Cart");
  const base = git("rev-parse", "--short", "HEAD");
  git("checkout", "-qb", "stack/01-discounts");
  put("src/cart.js", "export function total(items, discount = 0) {\n  const sum = items.reduce((n, i) => n + i.price, 0);\n  return sum - discount;\n}\n");
  git("commit", "-qam", "Discounts on the cart's total");
  git("checkout", "-qb", "stack/02-tax");
  put("src/tax.js", "export const RATE = 0.2;\n\nexport function withTax(amount) {\n  return amount * (1 + RATE);\n}\n");
  git("add", "-A");
  git("commit", "-qm", "Tax");
  git("checkout", "-q", "main");

  const root = path.join(dir, "review");
  fs.mkdirSync(path.join(root, "pages/review"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "in-ctrl.config.yaml"),
    `title: Shop review\nreview:\n  repo: ../shop\n  branchPrefix: stack/\n  baseBranch: main\n  stackBase: ${base}\n`,
  );
  fs.writeFileSync(path.join(root, "index.html"), page("Shop review", "", "<h1>Shop review</h1>"));
  fs.writeFileSync(
    path.join(root, "pages/review/index.html"),
    page("The stack", `<meta name="guide:section" content="review">`, `<h1>The stack</h1><review-list></review-list>`),
  );
  for (const [n, branch, title] of [["01", "stack/01-discounts", "Discounts"], ["02", "stack/02-tax", "Tax"]]) {
    fs.writeFileSync(
      path.join(root, `pages/review/${branch.split("/")[1]}.html`),
      page(
        `${n} · ${title}`,
        `<meta name="guide:section" content="review">\n<meta name="guide:order" content="${n}">\n<meta name="guide:parent" content="/pages/review/index.html">\n<meta name="guide:branch" content="${branch}">`,
        `<review-header branch="${branch}" risk="low"></review-header>\n<h2 id="code">Code</h2>\n<review-code branch="${branch}"></review-code>`,
      ),
    );
  }
  return { dir, repo, root, git };
}

function page(title, metas, body) {
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>${title}</title>\n${metas}\n</head>\n<body>\n<guide-nav></guide-nav>\n<main>\n${body}\n</main>\n</body>\n</html>\n`;
}

test("review: data from git, a published review, comments, verdicts and the merge", { timeout: 180000 }, async () => {
  const { dir, root, git } = project();
  let served;
  let browser;
  try {
    // 1. The stack's data: each branch against the one before it.
    await run(root, ["review", "gen", "--check"]);
    const index = JSON.parse(fs.readFileSync(path.join(root, "generated/branches/index.json"), "utf8"));
    assert.deepEqual(
      index.map((b) => [b.name, b.parent, b.added, b.removed]),
      [
        ["stack/01-discounts", "main", 3, 2],
        ["stack/02-tax", "stack/01-discounts", 5, 0],
      ],
    );

    // 2. Published, and served with the comments and the inbox.
    assert.match(await run(root, ["review", "publish"]), /published \d{8}-\d{6}/);
    assert.ok(fs.existsSync(path.join(root, "live/pages/review/01-discounts.html")));
    served = cli(root, ["review", "serve", "127.0.0.1:0"]);
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`review serve did not start: ${served.output()}`)), 10000);
      served.child.stdout.on("data", () => {
        const match = served.output().match(/review on (http:\/\/\S+)/);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
    });

    // 3. A branch's page: its diff, and lines added and removed in the sidebar.
    browser = await chromium.launch();
    const tab = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    const errors = [];
    tab.on("pageerror", (e) => errors.push(e.message));
    await tab.goto(new URL("pages/review/01-discounts.html", url).href);
    await tab.locator(".nav-diffstat").first().waitFor();
    assert.deepEqual(await tab.locator(".nav-diffstat").allTextContents(), ["+3 −2", "+5 −0"]);
    await tab.locator("td.code.add", { hasText: "return sum - discount;" }).first().waitFor();

    // 4. A comment on a line, the file reviewed, and the branch approved.
    const line = tab.locator("td.code.add", { hasText: "return sum - discount;" }).first();
    await line.hover();
    await line.locator(".add-comment").click();
    await tab.locator(".composer textarea").fill("Can the discount be bigger than the sum?");
    await tab.locator(".composer .save").click();
    await tab.locator(".reviewed-box input").first().check();
    await tab.locator(".comments-fab:not(.ai-fab)").click();
    await tab.locator('.verdicts input[value="approve"]').check();
    const store = path.join(root, ".in-ctrl/comments.json");
    await waitFor(() => readComments(store).reviews["stack/01-discounts"]?.verdict === "approve");
    const state = readComments(store);
    const [comment] = Object.values(state.comments);
    assert.equal(comment.branch, "stack/01-discounts");
    assert.equal(comment.file, "src/cart.js");
    assert.equal(comment.line, 3);
    assert.equal(comment.text, "Can the discount be bigger than the sum?");
    assert.equal(Object.keys(state.reviewed).length, 1);

    // 5. The agent reads the review and answers from a shell; the page shows it without a reload.
    const report = await run(root, ["comments"]);
    assert.match(report, /## stack\/01-discounts/);
    assert.match(report, /\*\*Verdict: approve\*\*/);
    assert.match(report, /`src\/cart\.js:3`/);
    await run(root, ["comments", "reply", comment.id.slice(0, 8), "Not yet: it should stop at zero.", "--as", "claude"]);
    // (The file is folded once reviewed; the sidebar says a reply waits.)
    await tab.locator(".nav-status .st.reply", { hasText: "↩1" }).waitFor({ timeout: 10000 });

    // 6. Approved means merged: main fast-forwards to the approved branch, the next one waits.
    assert.match(await run(root, ["review", "merge"]), /Merge 1 branch\(es\) into main: up to stack\/01-discounts\./);
    await run(root, ["review", "merge", "--apply"]);
    assert.equal(git("rev-parse", "main"), git("rev-parse", "stack/01-discounts"));
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    if (served && served.child.exitCode === null) {
      const exited = once(served.child, "exit");
      served.child.kill("SIGTERM");
      await exited;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("review: send to the agent, and the inbox from a shell", { timeout: 60000 }, async () => {
  const { dir, root } = project();
  try {
    const { inboxApi } = await import("../src/node/review/inbox.mjs");
    const file = path.join(root, ".in-ctrl/inbox.json");
    const api = inboxApi(file);
    const { createServer } = await import("node:http");
    const server = createServer((req, res) => api(req, res) || res.writeHead(404).end());
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const at = `http://127.0.0.1:${server.address().port}/_in-ctrl/inbox`;
    const sent = await (await fetch(at, { method: "POST", body: JSON.stringify({ note: "Look at the tax first" }) })).json();
    server.close();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].status, "pending");

    const waited = JSON.parse(await run(root, ["review", "inbox", "wait"]));
    assert.equal(waited[0].note, "Look at the tax first");
    await run(root, ["review", "inbox", "start", sent[0].id.slice(0, 8)]);
    await run(root, ["review", "inbox", "done", sent[0].id.slice(0, 8), "Fixed the rate"]);
    const [done] = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(done.status, "done");
    assert.equal(done.reply, "Fixed the rate");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function waitFor(check, timeout = 10000) {
  const until = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
