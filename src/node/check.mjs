// Fail if a diagram's PNG is missing or older than its source, if no page
// shows a diagram, or if a diagram names an icon no set has. No browser needed.

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { diagramSources, pngOf } from "./config.mjs";
import { buildIcons, unknownIcons } from "./icons.mjs";
import { digest, stampOf } from "./stamp.mjs";

export function check(config) {
  const errors = [];
  const shown = new Set();
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".md")) {
        for (const m of fs.readFileSync(full, "utf8").matchAll(/!\[[^\]]*\]\(([^)\s]+\.png)\)/g)) shown.add(path.resolve(dir, m[1]));
      }
    }
  })(config.root);
  const sources = diagramSources(config);
  const texts = sources.map((f) => fs.readFileSync(f, "utf8"));
  for (const [i, file] of sources.entries()) {
    const rel = path.relative(config.root, file);
    try {
      YAML.parse(texts[i]);
    } catch (e) {
      errors.push(`${rel}: not valid YAML: ${e.message.split("\n")[0]}`);
      continue;
    }
    const stamp = stampOf(pngOf(file));
    if (stamp === null) errors.push(`${rel}: no rendered PNG; run \`in-ctrl render\``);
    else if (stamp !== digest(file)) errors.push(`${rel}: the PNG is older than the source; run \`in-ctrl render\``);
    if (!shown.has(pngOf(file))) errors.push(`${rel}: no Markdown page shows it`);
  }
  const all = [...texts, JSON.stringify(config.vocabulary)];
  for (const id of unknownIcons(all, buildIcons(all))) errors.push(`unknown icon ${id}`);
  for (const e of errors) console.log(e);
  if (errors.length) return 1;
  console.log(`Diagrams are in sync (${sources.length} diagrams).`);
  return 0;
}
