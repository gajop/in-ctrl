import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "playwright";
import YAML from "yaml";
import { readComments } from "../src/node/comments.mjs";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

function cli(root, args) {
  const child = spawn(process.execPath, [path.join(packageRoot, "bin/in-ctrl.mjs"), ...args, "--root", root], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (data) => { output += data; });
  }
  return { child, output: () => output };
}

test("live comments UI allows adding comments, replying via CLI, and resolving in browser", { timeout: 60000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "in-ctrl-e2e-"));
  let dev;
  let browser;

  try {
    fs.cpSync(path.join(packageRoot, "test/fixture"), root, { recursive: true });

    // 1. Start dev server
    dev = cli(root, ["site", "dev"]);
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Dev server did not start: ${dev.output()}`)), 25000);
      dev.child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Dev server exited (${code}): ${dev.output()}`));
      });
      dev.child.stdout.on("data", () => {
        const match = dev.output().match(/site on (http:\/\/localhost:\d+\/)/);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
    });

    // 2. Launch headless browser
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(new URL("architecture/", url).href);
    // A fresh dev server may reload the page once while it bundles dependencies.
    await page.waitForLoadState("networkidle");

    // 3. Verify comments UI initialized
    await page.waitForSelector("body.ic-comments-on", { timeout: 10000 });
    const toggle = page.locator(".ic-panel-toggle");
    await assert.doesNotReject(toggle.waitFor({ state: "visible" }));
    assert.equal(await toggle.textContent(), "💬 0");

    // 4. Hover over first paragraph to reveal comment button
    const firstP = page.locator(".sl-markdown-content p").first();
    await firstP.hover();

    const blockBtn = page.locator(".ic-block-button:not(.ic-box-button)");
    await blockBtn.waitFor({ state: "visible", timeout: 5000 });

    // 5. Click comment button to open composer
    await blockBtn.click();
    const textarea = page.locator(".ic-composer textarea");
    await textarea.waitFor({ state: "visible", timeout: 5000 });

    // 6. Enter text and submit comment
    await textarea.fill("E2E Test comment on architecture");
    await page.locator(".ic-composer .ic-save").click();

    // 7. Verify comment thread appears under paragraph
    const thread = page.locator(".ic-thread");
    await thread.waitFor({ state: "visible", timeout: 5000 });
    assert.ok((await thread.textContent()).includes("E2E Test comment on architecture"));
    assert.ok((await thread.textContent()).includes("You"));
    assert.equal(await toggle.textContent(), "💬 1");

    // 8. Verify comments file on disk
    const commentsFile = path.join(root, ".in-ctrl/comments.json");
    assert.ok(fs.existsSync(commentsFile), "comments.json should exist");
    const state = readComments(commentsFile);
    const commentIds = Object.keys(state.comments);
    assert.equal(commentIds.length, 1);
    const firstId = commentIds[0];
    assert.equal(state.comments[firstId].text, "E2E Test comment on architecture");
    assert.equal(state.comments[firstId].file, "docs/architecture.md");

    // 9. Reply via CLI command
    const replyRun = cli(root, ["comments", "reply", firstId.slice(0, 8), "Agent verified response", "--as", "claude"]);
    const [replyExit] = await once(replyRun.child, "exit");
    assert.equal(replyExit, 0, replyRun.output());

    // 10. Verify browser received reply via real-time SSE stream without reload
    const agentComment = page.locator(".ic-comment.ic-from-author");
    await agentComment.waitFor({ state: "visible", timeout: 5000 });
    assert.ok((await agentComment.textContent()).includes("Agent verified response"));
    assert.ok((await agentComment.textContent()).includes("Claude"));

    // 11. Click Resolve in browser: resolved thread leaves the page by default
    const resolveBtn = page.locator(".ic-thread .ic-resolve");
    await resolveBtn.click();
    await thread.waitFor({ state: "detached", timeout: 5000 });
    assert.equal(await toggle.textContent(), "💬 0");

    // 12. Open panel and verify resolved thread is listed there
    await toggle.click();
    const panel = page.locator(".ic-panel");
    await panel.waitFor({ state: "visible", timeout: 5000 });
    assert.ok((await panel.textContent()).includes("resolved"));

    // 13. Enable "Show resolved on pages" and verify thread returns with resolved tag
    const showResolvedBox = page.locator(".ic-show-resolved");
    await showResolvedBox.check();
    await thread.waitFor({ state: "visible", timeout: 5000 });
    assert.ok(await thread.locator(".ic-resolved-tag").isVisible());

    // 14. Verify disk state reflects resolved thread
    const updatedState = readComments(commentsFile);
    const threadKey = `t|${state.comments[firstId].thread}`;
    assert.equal(updatedState.resolved[threadKey], true);

    // 15. Comment on a diagram box (verifies shadow DOM interaction and about tags)
    const diagram = page.locator(".in-ctrl-diagram").first();
    await diagram.waitFor({ state: "visible", timeout: 10000 });
    const node = diagram.locator(".react-flow__node").first();
    await node.waitFor({ state: "visible", timeout: 20000 });
    await node.hover();

    const boxBtn = page.locator(".ic-box-button");
    await boxBtn.waitFor({ state: "visible", timeout: 5000 });
    await boxBtn.click();

    const boxComposer = page.locator(".ic-composer");
    await boxComposer.waitFor({ state: "visible", timeout: 5000 });
    assert.ok(await boxComposer.locator(".ic-about").isVisible());

    await boxComposer.locator("textarea").fill("Comment specifically about this node");
    await boxComposer.locator(".ic-save").click();

    const boxThread = page.locator(".ic-thread").last();
    await boxThread.waitFor({ state: "visible", timeout: 5000 });
    assert.ok((await boxThread.textContent()).includes("Comment specifically about this node"));
    assert.ok((await boxThread.locator(".ic-about-tag").textContent()).includes("about"));
  } finally {
    if (browser) await browser.close();
    if (dev && dev.child.exitCode === null) {
      const exited = once(dev.child, "exit");
      dev.child.kill("SIGTERM");
      await exited;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** Start `in-ctrl site serve` on a free port; resolves to its URL. */
async function serveBuilt(root, out, extra = []) {
  const run = cli(root, ["site", "serve", out, "--port", "0", ...extra]);
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`site serve did not start: ${run.output()}`)), 10000);
    run.child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`site serve exited (${code}): ${run.output()}`));
    });
    run.child.stdout.on("data", () => {
      const match = run.output().match(/site on (http:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
  });
  return { run, url };
}

async function stop(run) {
  if (run && run.child.exitCode === null) {
    const exited = once(run.child, "exit");
    run.child.kill("SIGTERM");
    await exited;
  }
}

test("a built site served by site serve takes comments, on a phone too", { timeout: 120000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "in-ctrl-e2e-built-"));
  let served;
  let plain;
  let browser;
  try {
    fs.cpSync(path.join(packageRoot, "test/fixture"), root, { recursive: true });
    const configPath = path.join(root, "in-ctrl.config.yaml");
    const config = YAML.parse(fs.readFileSync(configPath, "utf8"));
    config.site = { ...config.site, base: "/shop/" };
    fs.writeFileSync(configPath, YAML.stringify(config));
    const out = path.join(root, "dist");

    // 1. The comment UI is part of the built pages.
    const build = cli(root, ["site", "build", out]);
    const [code] = await once(build.child, "exit");
    assert.equal(code, 0, build.output());
    const assets = fs.readdirSync(path.join(out, "_astro"));
    assert.ok(
      assets.some((f) => f.endsWith(".js") && fs.readFileSync(path.join(out, "_astro", f), "utf8").includes("_in-ctrl/comments")),
      "no built script talks to the comments API",
    );

    // 2. site serve answers the API under the site's base.
    served = await serveBuilt(root, out);
    const api = new URL("_in-ctrl/comments", served.url).href;
    assert.match(served.url, /\/shop\/$/);
    const empty = await fetch(api);
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), { comments: {}, resolved: {} });

    // 3. A phone: tap a paragraph, tap its 💬, write, save.
    browser = await chromium.launch();
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const page = await phone.newPage();
    await page.goto(new URL("architecture/", served.url).href);
    await page.waitForSelector("body.ic-comments-on", { timeout: 10000 });
    await page.locator(".sl-markdown-content p").first().tap();
    const button = page.locator(".ic-block-button:not(.ic-box-button)");
    await button.waitFor({ state: "visible", timeout: 5000 });
    await button.tap();
    const textarea = page.locator(".ic-composer textarea");
    await textarea.waitFor({ state: "visible", timeout: 5000 });
    await textarea.fill("From a phone");
    await page.locator(".ic-composer .ic-save").tap();
    await page.locator(".ic-thread").waitFor({ state: "visible", timeout: 5000 });

    // 4. Stored in the project's comments file, with its Markdown source.
    const file = path.join(root, ".in-ctrl/comments.json");
    const [id] = Object.keys(readComments(file).comments);
    assert.ok(id, "the comment was not stored");
    assert.equal(readComments(file).comments[id].file, "docs/architecture.md");
    assert.equal(readComments(file).comments[id].page, "/shop/architecture/");
    assert.equal(fs.readFileSync(path.join(root, ".in-ctrl/.gitignore"), "utf8"), "*\n");

    // 5. A reply from a shell reaches the open page without a reload, and the API.
    const answer = cli(root, ["comments", "reply", id.slice(0, 8), "Seen it", "--as", "claude"]);
    const [answered] = await once(answer.child, "exit");
    assert.equal(answered, 0, answer.output());
    await page.locator(".ic-comment.ic-from-author").waitFor({ state: "visible", timeout: 10000 });
    const after = await (await fetch(api)).json();
    assert.ok(Object.values(after.comments).some((c) => c.author === "claude" && c.text === "Seen it" && c.thread === id));

    // 6. Pages and the 404 page still work beside the API; other methods are refused.
    assert.equal((await fetch(new URL("architecture/", served.url))).status, 200);
    assert.equal((await fetch(new URL("missing/", served.url))).status, 404);
    assert.equal((await fetch(api, { method: "PUT" })).status, 405);
    assert.equal((await fetch(api, { method: "POST", body: "not json" })).status, 400);

    // 7. --no-comments: no API, and the same pages show no comment UI.
    plain = await serveBuilt(root, out, ["--no-comments"]);
    assert.equal((await fetch(new URL("_in-ctrl/comments", plain.url))).status, 404);
    const quiet = await phone.newPage();
    await quiet.goto(new URL("architecture/", plain.url).href);
    await quiet.waitForLoadState("networkidle");
    assert.equal(await quiet.locator("body.ic-comments-on").count(), 0);
  } finally {
    if (browser) await browser.close();
    await stop(served?.run);
    await stop(plain?.run);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a line of code takes its own comment, quoted with its file and line", { timeout: 120000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "in-ctrl-e2e-code-"));
  let served;
  let browser;
  try {
    fs.cpSync(path.join(packageRoot, "test/fixture"), root, { recursive: true });
    fs.writeFileSync(path.join(root, "docs/setup.md"), '# Setup\n\nThe server reads one file.\n\n```yaml title="app.yaml"\nname: shop\nport: 8080\n```\n');
    const out = path.join(root, "dist");
    const build = cli(root, ["site", "build", out]);
    const [code] = await once(build.child, "exit");
    assert.equal(code, 0, build.output());
    served = await serveBuilt(root, out);

    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(new URL("setup/", served.url).href);
    await page.waitForSelector("body.ic-comments-on", { timeout: 10000 });
    await page.locator(".ec-line").nth(1).hover();
    await page.locator(".ic-block-button:not(.ic-box-button)").click();
    await page.locator(".ic-composer textarea").fill("Why this port?");
    await page.locator(".ic-composer .ic-save").click();
    // The thread opens between the lines of code, under the line it is about.
    const thread = page.locator(".expressive-code .ic-thread");
    await thread.waitFor({ state: "visible", timeout: 5000 });

    const file = path.join(root, ".in-ctrl/comments.json");
    const [comment] = Object.values(readComments(file).comments);
    assert.equal(comment.anchor.quote, "app.yaml:2: port: 8080");
  } finally {
    if (browser) await browser.close();
    await stop(served?.run);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
