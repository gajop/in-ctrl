import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "playwright";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

function cli(root, args) {
  const child = spawn(process.execPath, [path.join(packageRoot, "bin/in-ctrl.mjs"), ...args, "--root", root], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => { output += data; });
  return { child, output: () => output };
}

test("built diagrams expand across the viewport and return to the page", { timeout: 120000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "in-ctrl-fullscreen-"));
  let server;
  let browser;
  try {
    fs.cpSync(path.join(packageRoot, "test/fixture"), root, { recursive: true });
    // A graph too large to fit must still open with readable labels.
    const longGraph = {
      title: "Long reading graph", direction: "RIGHT",
      nodes: Array.from({ length: 25 }, (_, i) => ({ id: `n${i}`, label: `Decision ${i}`, detail: "Persistent state and ordinary execution" })),
      edges: Array.from({ length: 24 }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}` })),
    };
    fs.writeFileSync(path.join(root, "docs/diagrams/long.diagram.yaml"), JSON.stringify(longGraph));
    fs.copyFileSync(path.join(root, "docs/diagrams/deployment.png"), path.join(root, "docs/diagrams/long.png"));
    fs.appendFileSync(path.join(root, "docs/architecture.md"), "\n![Large reading graph](diagrams/long.png)\n");
    const out = path.join(root, "dist");
    const build = cli(root, ["site", "build", out]);
    const [code] = await once(build.child, "exit");
    assert.equal(code, 0, build.output());
    server = cli(root, ["site", "serve", out, "--port", "0"]);
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(server.output())), 10000);
      server.child.once("exit", () => { clearTimeout(timer); reject(new Error(server.output())); });
      server.child.stdout.on("data", () => {
        const match = server.output().match(/site on (http:\/\/[^\s]+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
    });
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(new URL("architecture/", url).href);
    const graph = page.locator(".in-ctrl-diagram").first();
    await graph.locator(".react-flow__node").first().waitFor();
    const open = graph.getByRole("button", { name: "Full screen", exact: true });
    await open.scrollIntoViewIfNeeded();
    // Let ResizeObserver and React Flow finish the initial viewport sizing.
    await page.waitForTimeout(200);
    // Help belongs to the framework; keyboard users can dismiss it without
    // changing the page or the diagram viewport.
    const help = graph.getByRole("button", { name: "Diagram help", exact: true });
    await help.focus();
    await page.keyboard.press("Enter");
    const inlineHelp = graph.getByRole("region", { name: "Diagram controls" });
    await inlineHelp.waitFor();
    assert.match(await inlineHelp.textContent(), /Fit view/);
    assert.equal(await help.getAttribute("aria-expanded"), "true");
    await page.keyboard.press("Escape");
    await inlineHelp.waitFor({ state: "hidden" });
    assert.equal(await help.evaluate((button) => button.getRootNode().activeElement === button), true);
    await help.click();
    await page.locator("main h1").click();
    await inlineHelp.waitFor({ state: "hidden" });
    await open.scrollIntoViewIfNeeded();
    // Inline gestures scroll the document without changing the diagram view.
    const inlineViewport = graph.locator(".react-flow__viewport");
    const inlineStyle = await inlineViewport.getAttribute("style");
    assert.equal(await graph.locator(".react-flow__controls").count(), 0);
    const inlineBounds = await graph.locator(".react-flow").boundingBox();
    const dragX = inlineBounds.x + inlineBounds.width - 20;
    const dragY = inlineBounds.y + inlineBounds.height / 2;
    await page.mouse.move(dragX, dragY);
    await page.mouse.down();
    await page.mouse.move(dragX - 100, dragY - 30, { steps: 5 });
    await page.mouse.up();
    assert.equal(await inlineViewport.getAttribute("style"), inlineStyle);
    await page.mouse.dblclick(dragX, dragY);
    assert.equal(await inlineViewport.getAttribute("style"), inlineStyle);
    const beforeWheel = await page.evaluate(() => window.scrollY);
    await page.mouse.wheel(0, 180);
    await page.waitForFunction((before) => window.scrollY > before, beforeWheel);
    assert.equal(await inlineViewport.getAttribute("style"), inlineStyle);
    await open.scrollIntoViewIfNeeded();
    const scroll = await page.evaluate(() => window.scrollY);
    await open.click();
    const dialog = graph.getByRole("dialog");
    await dialog.waitFor();
    await dialog.locator(".react-flow__node").first().waitFor();
    const fullscreenHelp = dialog.getByRole("region", { name: "Diagram controls" });
    await dialog.getByRole("button", { name: "Diagram help", exact: true }).click();
    await fullscreenHelp.waitFor();
    await page.keyboard.press("Escape");
    await fullscreenHelp.waitFor({ state: "hidden" });
    assert.equal(await dialog.isVisible(), true, "Escape dismisses help before exiting fullscreen");
    const rect = await dialog.boundingBox();
    assert.deepEqual(rect, { x: 0, y: 0, width: 1280, height: 800 });
    assert.equal(await page.evaluate(() => document.documentElement.style.overflow), "hidden");
    const canvas = dialog.locator(".react-flow");
    const canvasRect = await canvas.boundingBox();
    assert.ok(canvasRect.width > 1200 && canvasRect.height > 700);
    await dialog.getByRole("button", { name: "fit view" }).click();
    await page.waitForTimeout(300);
    for (const node of await dialog.locator(".react-flow__node").all()) {
      const bounds = await node.boundingBox();
      assert.ok(bounds.x >= canvasRect.x && bounds.y >= canvasRect.y);
      assert.ok(bounds.x + bounds.width <= canvasRect.x + canvasRect.width + 1);
      assert.ok(bounds.y + bounds.height <= canvasRect.y + canvasRect.height + 1);
    }
    const viewport = dialog.locator(".react-flow__viewport");
    const transform = await viewport.getAttribute("style");
    await dialog.getByRole("button", { name: "zoom in" }).click();
    await page.waitForFunction((old) => {
      const shadow = document.querySelector(".in-ctrl-diagram").shadowRoot;
      return shadow.querySelector("dialog .react-flow__viewport").getAttribute("style") !== old;
    }, transform);
    const beforePan = await viewport.getAttribute("style");
    await page.mouse.move(canvasRect.x + canvasRect.width - 70, canvasRect.y + 70);
    await page.mouse.down();
    await page.mouse.move(canvasRect.x + canvasRect.width - 160, canvasRect.y + 130, { steps: 5 });
    await page.mouse.up();
    assert.notEqual(await viewport.getAttribute("style"), beforePan, "fullscreen drag pans the diagram");
    const beforeZoomWheel = await viewport.getAttribute("style");
    await page.mouse.wheel(0, -100);
    await page.waitForFunction((old) => {
      return document.querySelector(".in-ctrl-diagram").shadowRoot.querySelector("dialog .react-flow__viewport").getAttribute("style") !== old;
    }, beforeZoomWheel);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.documentElement.style.overflow === "");
    assert.equal(await open.evaluate((button) => button.getRootNode().activeElement === button), true);
    assert.equal(await page.evaluate(() => window.scrollY), scroll);
    assert.equal(await page.evaluate(() => document.documentElement.style.overflow), "");

    // Reopen, resize, and close with the visible button.
    await open.click();
    await page.setViewportSize({ width: 390, height: 844 });
    await dialog.locator(".react-flow__node").first().waitFor();
    assert.deepEqual(await dialog.boundingBox(), { x: 0, y: 0, width: 390, height: 844 });
    await dialog.getByRole("button", { name: "Exit full screen" }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.setViewportSize({ width: 1280, height: 800 });

    // Node comments still work after returning from the reading view.
    await graph.locator(".react-flow__node").first().hover();
    await page.locator(".ic-box-button").click();
    await page.locator(".ic-composer textarea").fill("Fullscreen leaves node comments usable");
    await page.locator(".ic-composer .ic-save").click();
    await page.locator(".ic-thread").waitFor();

    const sequence = page.locator(".in-ctrl-diagram").nth(1);
    await sequence.getByRole("button", { name: "Full screen", exact: true }).click();
    const seqDialog = sequence.getByRole("dialog");
    await seqDialog.locator(".cd-seq > svg").waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await seqDialog.getByRole("button", { name: "Diagram help", exact: true }).click();
    const seqHelp = seqDialog.getByRole("region", { name: "Diagram controls" });
    await seqHelp.waitFor();
    assert.match(await seqHelp.textContent(), /full-size sequence/);
    assert.doesNotMatch(await seqHelp.textContent(), /Fit view|zoom/);
    const seqHelpBounds = await seqHelp.boundingBox();
    assert.ok(seqHelpBounds.x >= 0 && seqHelpBounds.x + seqHelpBounds.width <= 390);
    await page.keyboard.press("Escape");
    await seqHelp.waitFor({ state: "hidden" });
    const overflow = await seqDialog.locator(".cd-seq").evaluate((element) => ({
      width: element.clientWidth, contentWidth: element.scrollWidth,
      mode: getComputedStyle(element).overflow,
    }));
    assert.equal(overflow.mode, "auto");
    assert.ok(overflow.contentWidth > overflow.width, "sequence keeps readable natural dimensions on a phone");
    await seqDialog.locator(".cd-seq").evaluate((element) => { element.scrollLeft = 100; });
    assert.ok(await seqDialog.locator(".cd-seq").evaluate((element) => element.scrollLeft > 0));
    await seqDialog.getByRole("button", { name: "Exit full screen" }).click();
    await seqDialog.waitFor({ state: "hidden" });

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.locator("starlight-theme-select select").first().selectOption("dark");
    await sequence.getByRole("button", { name: "Full screen", exact: true }).click();
    await seqDialog.waitFor();
    assert.ok(await seqDialog.evaluate((element) => element.classList.contains("cd-dark")));
    await page.keyboard.press("Escape");
    await seqDialog.waitFor({ state: "hidden" });
    await page.setViewportSize({ width: 1280, height: 800 });
    const long = page.locator(".in-ctrl-diagram").nth(2);
    await long.getByRole("button", { name: "Full screen", exact: true }).click();
    const longDialog = long.getByRole("dialog");
    await longDialog.locator(".react-flow__node").first().waitFor();
    const readingStyle = await longDialog.locator(".react-flow__viewport").getAttribute("style");
    assert.ok(Number(readingStyle.match(/scale\(([^)]+)\)/)[1]) >= 0.9, "large graph opens at a readable scale");
    await longDialog.getByRole("button", { name: "fit view" }).click();
    await page.waitForTimeout(300);
    const overviewStyle = await longDialog.locator(".react-flow__viewport").getAttribute("style");
    assert.ok(Number(overviewStyle.match(/scale\(([^)]+)\)/)[1]) < 0.9, "Fit still provides the entire graph overview");
    await page.keyboard.press("Escape");
    await longDialog.waitFor({ state: "hidden" });
    const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const mobile = await mobileContext.newPage();
    mobile.on("pageerror", (error) => errors.push(String(error)));
    await mobile.goto(new URL("architecture/", url).href);
    const mobileGraph = mobile.locator(".in-ctrl-diagram").first();
    await mobileGraph.locator(".react-flow__node").first().waitFor();
    const touchHelp = mobileGraph.getByRole("button", { name: "Diagram help", exact: true });
    await touchHelp.tap();
    const touchPanel = mobileGraph.getByRole("region", { name: "Diagram controls" });
    await touchPanel.waitFor();
    const touchBounds = await touchHelp.boundingBox();
    assert.ok(touchBounds.width >= 44 && touchBounds.height >= 44);
    const panelBounds = await touchPanel.boundingBox();
    assert.ok(panelBounds.x >= 0 && panelBounds.x + panelBounds.width <= 390);
    await touchHelp.tap();
    await touchPanel.waitFor({ state: "hidden" });
    const cdp = await mobileContext.newCDPSession(mobile);
    for (const target of [mobileGraph.locator(".react-flow__pane"), mobileGraph.locator(".react-flow__node").last()]) {
      await target.scrollIntoViewIfNeeded();
      const bounds = await target.boundingBox();
      const x = bounds.x + bounds.width / 2;
      const y = Math.min(700, bounds.y + bounds.height / 2);
      const before = await mobile.evaluate(() => window.scrollY);
      const style = await mobileGraph.locator(".react-flow__viewport").getAttribute("style");
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      for (let step = 1; step <= 5; step++) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - step * 25 }] });
        await mobile.waitForTimeout(40);
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await mobile.waitForFunction((old) => window.scrollY > old, before);
      assert.equal(await mobileGraph.locator(".react-flow__viewport").getAttribute("style"), style);
    }
    await mobileGraph.getByRole("button", { name: "Full screen", exact: true }).click();
    const mobileDialog = mobileGraph.getByRole("dialog");
    await mobileDialog.locator(".react-flow__node").first().waitFor();
    const mobileStyle = await mobileDialog.locator(".react-flow__viewport").getAttribute("style");
    const pageScroll = await mobile.evaluate(() => window.scrollY);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 240, y: 500 }] });
    for (let step = 1; step <= 5; step++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 240 - step * 15, y: 500 - step * 15 }] });
      await mobile.waitForTimeout(40);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    assert.notEqual(await mobileDialog.locator(".react-flow__viewport").getAttribute("style"), mobileStyle, "fullscreen mobile swipe pans the diagram");
    assert.equal(await mobile.evaluate(() => window.scrollY), pageScroll);
    await mobileContext.close();
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (server?.child.exitCode === null) {
      const exited = once(server.child, "exit");
      server.child.kill("SIGTERM");
      await exited;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
