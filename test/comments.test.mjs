import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import YAML from "yaml";
import { readComments, applyOps, reply, report, threadKey, sourceResolver } from "../src/node/comments.mjs";
import { loadConfig } from "../src/node/config.mjs";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

function cli(root, args) {
  const child = spawn(process.execPath, [path.join(packageRoot, "bin/in-ctrl.mjs"), ...args, "--root", root], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => { stdout += data; });
  child.stderr.on("data", (data) => { stderr += data; });
  return { child, stdout: () => stdout, stderr: () => stderr, output: () => stdout + stderr };
}

test("comments store handles read, ops, reply, and markdown report", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "in-ctrl-comments-test-"));
  try {
    const file = path.join(tmpDir, ".in-ctrl/comments.json");

    // 1. Initial read should be empty
    const initial = readComments(file);
    assert.deepEqual(initial, { comments: {}, resolved: {}, reviewed: {}, reviews: {}, marks: {} });

    // 2. Add a comment
    const comment1 = {
      id: "c1",
      page: "/guide/",
      anchor: { section: "install", sectionTitle: "Installation", block: "b0", quote: "npm install in-ctrl" },
      text: "Is pnpm supported?",
      created: "2026-10-01T10:00:00.000Z",
    };
    applyOps(file, [{ coll: "comments", id: "c1", value: comment1 }], { sourceOf: () => "docs/guide.md" });

    const state1 = readComments(file);
    assert.equal(state1.comments.c1.text, "Is pnpm supported?");
    assert.equal(state1.comments.c1.file, "docs/guide.md");
    assert.equal(state1.comments.c1.thread, "c1");

    // 3. Reply to comment
    const answer = reply(file, "c1", "Yes, pnpm add -D in-ctrl works.", "claude");
    assert.equal(answer.author, "claude");
    assert.equal(answer.thread, "c1");

    const state2 = readComments(file);
    assert.equal(Object.keys(state2.comments).length, 2);

    // 4. Report open comments as Markdown
    const rep = report(state2);
    assert.ok(rep.includes("## docs/guide.md (/guide/)"));
    assert.ok(rep.includes('"Installation"'));
    assert.ok(rep.includes("npm install in-ctrl"));
    assert.ok(rep.includes("Is pnpm supported?"));
    assert.ok(rep.includes("claude"));
    assert.ok(rep.includes("Yes, pnpm add -D in-ctrl works."));

    // 5. Resolve thread
    const key = threadKey(state2.comments.c1);
    applyOps(file, [{ coll: "resolved", id: key, value: true }]);

    const state3 = readComments(file);
    assert.equal(state3.resolved[key], true);
    assert.equal(report(state3), "No open comments.");
    assert.ok(report(state3, { includeResolved: true }).includes("(resolved)"));

    // 6. Delete comment
    applyOps(file, [{ coll: "comments", id: "c1", value: null }]);
    const state4 = readComments(file);
    assert.equal(state4.comments.c1, undefined);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sourceResolver maps page routes to source Markdown files", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "in-ctrl-comments-src-"));
  try {
    fs.mkdirSync(path.join(tmpDir, "docs/sub"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "docs/README.md"), "# Home\n");
    fs.writeFileSync(path.join(tmpDir, "docs/sub/topic.md"), "# Topic\n");
    fs.writeFileSync(path.join(tmpDir, "in-ctrl.config.yaml"), "title: Test\nsite:\n  base: /base/\n");

    const config = loadConfig(tmpDir);
    const resolve = sourceResolver(config);

    assert.equal(resolve("/base/"), "docs/README.md");
    assert.equal(resolve("/base/sub/topic/"), "docs/sub/topic.md");
    assert.equal(resolve("/nonexistent/"), undefined);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("CLI commands for listing comments and replying", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "in-ctrl-comments-cli-"));
  try {
    fs.cpSync(path.join(packageRoot, "test/fixture"), root, { recursive: true });

    // 1. Initial listing: no comments
    const list1 = cli(root, ["comments"]);
    const [code1] = await once(list1.child, "exit");
    assert.equal(code1, 0);
    assert.ok(list1.stdout().includes("No open comments."));

    // 2. Add comment directly to the store
    const commentsFile = path.join(root, ".in-ctrl/comments.json");
    applyOps(commentsFile, [
      {
        coll: "comments",
        id: "abcdef12-test",
        value: {
          id: "abcdef12-test",
          page: "/architecture/",
          anchor: { section: "order", sectionTitle: "Placing an order", block: "b1", quote: "A customer order" },
          text: "Question about order flow",
          created: "2026-10-02T12:00:00Z",
          thread: "abcdef12-test",
        },
      },
    ], { sourceOf: () => "docs/architecture.md" });

    // 3. List comments via CLI
    const list2 = cli(root, ["comments"]);
    const [code2] = await once(list2.child, "exit");
    assert.equal(code2, 0);
    assert.ok(list2.stdout().includes("## docs/architecture.md (/architecture/)"));
    assert.ok(list2.stdout().includes("Question about order flow"));
    assert.ok(list2.stdout().includes("abcdef12"));

    // 4. Reply via CLI
    const replyCmd = cli(root, ["comments", "reply", "abcdef12", "This is the answer from the agent", "--as", "claude"]);
    const [replyCode] = await once(replyCmd.child, "exit");
    assert.equal(replyCode, 0, replyCmd.output());
    assert.ok(replyCmd.stdout().includes("replied in the thread of abcdef12"));

    // 5. Verify reply appears in CLI listing
    const list3 = cli(root, ["comments"]);
    const [code3] = await once(list3.child, "exit");
    assert.equal(code3, 0);
    assert.ok(list3.stdout().includes("claude ["));
    assert.ok(list3.stdout().includes("This is the answer from the agent"));

    // 6. Error handling: reply to unknown ID
    const failReply = cli(root, ["comments", "reply", "nonexistent-id", "test"]);
    const [failCode] = await once(failReply.child, "exit");
    assert.equal(failCode, 1);
    assert.ok(failReply.stderr().includes("0 comments match nonexistent-id"));

    // 7. Error handling when comments: false
    const configPath = path.join(root, "in-ctrl.config.yaml");
    const config = YAML.parse(fs.readFileSync(configPath, "utf8"));
    config.comments = false;
    fs.writeFileSync(configPath, YAML.stringify(config));

    const disabledList = cli(root, ["comments"]);
    const [disabledCode] = await once(disabledList.child, "exit");
    assert.equal(disabledCode, 1);
    assert.ok(disabledList.stderr().includes("comments are turned off"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the store keeps the review too: code comments, reviewed files, verdicts, section marks", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "in-ctrl-review-store-"));
  try {
    const file = path.join(dir, "comments.json");
    const code = { branch: "stack/01-discounts", file: "src/cart.js", line: 3, side: "new", code: "  return sum - discount;", text: "Below zero?", created: "2026-10-01T10:00:00.000Z" };
    applyOps(file, [
      { coll: "comments", id: "k1", value: code },
      { coll: "reviewed", id: "stack/01-discounts|src/cart.js|abcd1234", value: true },
      { coll: "reviews", id: "stack/01-discounts", value: { verdict: "request-changes", summary: "One question." } },
      { coll: "marks", id: "/pages/review/01-discounts.html#code", value: "needs-work" },
    ], { sourceOf: () => "docs/never.md" });
    const state = readComments(file);
    // A code comment keeps its place in the diff; a docs page's source isn't looked up for it.
    assert.deepEqual({ ...state.comments.k1 }, { id: "k1", ...code, thread: "k1" });
    assert.equal(state.reviews["stack/01-discounts"].verdict, "request-changes");

    reply(file, "k1", "It stops at zero now.", "claude");
    const md = report(readComments(file));
    assert.match(md, /## stack\/01-discounts\n\n\*\*Verdict: request-changes\*\*\n\nOne question\./);
    assert.match(md, /- `src\/cart\.js:3`\n  > `return sum - discount;`\n  - reader \[k1\]: Below zero\?\n  - claude \[[0-9a-f]{8}\]: It stops at zero now\./);
    assert.match(md, /## \/pages\/review\/01-discounts\.html\n\n- Section `code`: \*\*needs work\*\*/);

    // Values the review doesn't know are refused.
    assert.throws(() => applyOps(file, [{ coll: "reviews", id: "stack/02-tax", value: { verdict: "merge" } }]), /bad review/);
    assert.throws(() => applyOps(file, [{ coll: "marks", id: "/x#y", value: "meh" }]), /bad mark/);
    assert.throws(() => applyOps(file, [{ coll: "comments", id: "k2", value: { text: "nowhere" } }]), /needs a page or a branch/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
