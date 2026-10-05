// Redirects for pages that moved, from `site.redirects` in in-ctrl.config.yaml:
//
//   site:
//     redirects:
//       /old/page/: /new/page/          # one page
//       /old/folder/*: /new/folder/*    # a folder: every page under it, same relative path
//
// Paths are site paths without the base; a trailing slash is optional. The built site gets a
// small redirect page at each old path (static hosts follow it), and `in-ctrl site serve`
// answers old paths with a 302.

import fs from "node:fs";
import path from "node:path";

/** The config's redirects as rules: `{ from, to, prefix }`, paths with a leading and trailing slash. */
export function parseRedirects(raw) {
  if (raw == null) return [];
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("in-ctrl: site.redirects must be a map of old path → new path");
  return Object.entries(raw).map(([from, to]) => {
    if (typeof to !== "string") throw new Error(`in-ctrl: site.redirects: ${from} must map to a path`);
    const prefix = from.endsWith("*");
    if (prefix !== to.endsWith("*")) throw new Error(`in-ctrl: site.redirects: ${from} → ${to}: a folder rule ends in * on both sides`);
    return { from: slashed(prefix ? from.slice(0, -1) : from), to: slashed(prefix ? to.slice(0, -1) : to), prefix };
  });
}

function slashed(p) {
  let s = p.trim();
  if (!s.startsWith("/")) s = "/" + s;
  if (!s.endsWith("/")) s += "/";
  return s.replace(/\/{2,}/g, "/");
}

/** Where a site path (without the base) redirects to, or null. Exact rules win over folder rules. */
export function redirectFor(rules, sitePath) {
  const p = slashed(sitePath);
  const exact = rules.find((r) => !r.prefix && r.from === p);
  if (exact) return exact.to;
  let best = null;
  for (const r of rules) if (r.prefix && p.startsWith(r.from) && (!best || r.from.length > best.from.length)) best = r;
  return best ? best.to + p.slice(best.from.length) : null;
}

/** A redirect page at each old path in the built site; never over a page that exists. */
export function writeRedirectPages(rules, outDir, base = "/") {
  const written = [];
  const page = (fromPath, toPath) => {
    const file = path.join(outDir, ...fromPath.split("/").filter(Boolean), "index.html");
    if (fs.existsSync(file)) return;
    const href = joinBase(base, toPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `<!doctype html><meta charset="utf-8"><title>Moved</title><meta http-equiv="refresh" content="0; url=${href}"><link rel="canonical" href="${href}"><p>Moved to <a href="${href}">${href}</a>.</p>\n`);
    written.push(fromPath);
  };
  for (const r of rules) {
    if (!r.prefix) {
      page(r.from, r.to);
      continue;
    }
    // A folder rule: one page per page under the new folder, at the same place under the old one.
    const target = path.join(outDir, ...r.to.split("/").filter(Boolean));
    if (!fs.existsSync(target)) continue;
    (function walk(dir, rel) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(dir, e.name), rel + e.name + "/");
        else if (e.name === "index.html") page(r.from + rel, r.to + rel);
      }
    })(target, "");
  }
  return written;
}

export function joinBase(base, sitePath) {
  return (base.replace(/\/+$/, "") + sitePath).replace(/\/{2,}/g, "/");
}
