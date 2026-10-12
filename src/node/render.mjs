// Render each diagram to the PNG next to its source (light theme, 2x), which
// the Markdown embeds so GitHub shows the picture. The PNG carries the SHA-256
// of its source in a text chunk, so `in-ctrl check` can tell a stale image
// without a browser.

import fs from "node:fs";
import path from "node:path";
import { diagramSources, pngOf } from "./config.mjs";
import { digest, stampOf, withStamp } from "./stamp.mjs";
import { startRenderServer } from "./server.mjs";

export async function render(config, { all = false } = {}) {
  const todo = diagramSources(config).filter((f) => all || stampOf(pngOf(f)) !== digest(f));
  if (!todo.length) {
    console.log("Diagram images are up to date.");
    return 0;
  }
  const { chromium } = await import("playwright");
  const { server, url } = await startRenderServer(config);
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 2400, height: 1600 }, deviceScaleFactor: 2 });
  let failed = 0;
  page.on("pageerror", (e) => {
    failed++;
    console.error(e.message);
  });
  try {
    for (const file of todo) {
      const rel = path.relative(config.root, file);
      await page.goto(`${url}?file=${encodeURIComponent(rel)}&theme=light&fixed=1`, { waitUntil: "networkidle" });
      try {
        await page.waitForSelector(".react-flow__node, .cd-seq svg, .cd-map svg", { timeout: 20000 });
      } catch {
        const error = await page.locator(".cd-error").textContent().catch(() => null);
        console.error(`${rel}: ${error ?? "nothing was drawn"}`);
        failed++;
        continue;
      }
      await page.waitForTimeout(300);
      const png = await page.locator(".cd").first().screenshot();
      fs.writeFileSync(pngOf(file), withStamp(png, digest(file)));
      console.log(`rendered ${path.relative(config.root, pngOf(file))}`);
    }
  } finally {
    await browser.close();
    await server.close();
  }
  return failed ? 1 : 0;
}
