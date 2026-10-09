// The icons a project's diagrams use, as "set:name" → inline SVG markup:
//
//   gcp:*         official Google Cloud product icons (icons/gcp, from cloud.google.com/icons)
//   cloudflare:*  Cloudflare product icons (icons/cloudflare, from github.com/cloudflare/cloudflare-docs, CC BY 4.0)
//   logos:*       brand logos (@iconify-json/logos, CC0)
//   devicon:*     square product logos (@iconify-json/devicon, MIT)
//   lucide:*      generic shapes: people, terminals, servers (@iconify-json/lucide, ISC)
//
// One-colour icons (Cloudflare's, Lucide's) draw in `currentColor`, so the
// diagram sets their colour per theme.

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
const ID = /\b(gcp|cloudflare|logos|lucide|devicon):[a-z0-9-]+/g;

/** Icons for every id mentioned in `texts` (diagram sources, the vocabulary). */
export function buildIcons(texts) {
  const used = new Set(texts.flatMap((t) => [...t.matchAll(ID)].map((m) => m[0])));
  const out = {};
  for (const [set, mono] of [["gcp", false], ["cloudflare", true]]) {
    const dir = path.join(PACKAGE, "icons", set);
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".svg"))) {
      const id = `${set}:${f.slice(0, -4)}`;
      if (used.has(id)) out[id] = fromFile(path.join(dir, f), mono);
    }
  }
  for (const set of ["logos", "lucide", "devicon"]) {
    const json = JSON.parse(fs.readFileSync(require.resolve(`@iconify-json/${set}/icons.json`), "utf8"));
    for (const [name, icon] of Object.entries(json.icons)) {
      if (!used.has(`${set}:${name}`)) continue;
      const w = icon.width ?? json.width ?? 16;
      const h = icon.height ?? json.height ?? 16;
      out[`${set}:${name}`] = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${icon.left ?? 0} ${icon.top ?? 0} ${w} ${h}">${icon.body}</svg>`;
    }
  }
  return out;
}

/** Ids mentioned in `texts` that no icon set has. */
export function unknownIcons(texts, icons) {
  return [...new Set(texts.flatMap((t) => [...t.matchAll(ID)].map((m) => m[0])))].filter((id) => !icons[id]);
}

function fromFile(file, mono) {
  const text = fs.readFileSync(file, "utf8").replace(/<\?xml[^>]*>/, "").replace(/<!--[\s\S]*?-->/g, "");
  const open = text.match(/<svg\b[^>]*>/)[0];
  let viewBox = open.match(/viewBox="([^"]+)"/)?.[1];
  if (!viewBox) {
    const w = parseFloat(open.match(/width="([\d.]+)/)?.[1] ?? "24");
    const h = parseFloat(open.match(/height="([\d.]+)/)?.[1] ?? "24");
    viewBox = `0 0 ${w} ${h}`;
  }
  const inner = text.slice(text.indexOf(open) + open.length, text.lastIndexOf("</svg>"));
  const keep = ["fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin"]
    .map((a) => open.match(new RegExp(`\\s${a}="([^"]*)"`)))
    .filter(Boolean)
    .map((m) => m[0])
    .join("");
  const paint = mono && !/\sfill="/.test(open) ? ' fill="currentColor"' : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}"${keep}${paint}>${inner}</svg>`;
}
