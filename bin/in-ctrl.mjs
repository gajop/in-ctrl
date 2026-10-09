#!/usr/bin/env node
// in-ctrl: docs you stay in control of.
//
//   in-ctrl render [--all]      draw the diagrams that changed into their PNGs
//   in-ctrl check               fail if a PNG is missing or stale, or an icon unknown
//   in-ctrl dev                 every diagram, light and dark, in the browser
//   in-ctrl site build [DIR]    the docs site (default DIR: dist-docs)
//   in-ctrl site dev            the docs site, live
//
// Options: --root DIR (the project; default: the current directory).

import { loadConfig } from "../src/node/config.mjs";

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
};
const root = option("--root");
const all = args.includes("--all");
const positional = args.filter((a) => !a.startsWith("--"));
const config = loadConfig(root);
const [command, sub, dir] = positional;

switch (command) {
  case "render": {
    const { render } = await import("../src/node/render.mjs");
    process.exit(await render(config, { all }));
    break;
  }
  case "check": {
    const { check } = await import("../src/node/check.mjs");
    process.exit(check(config));
    break;
  }
  case "dev": {
    const { startRenderServer } = await import("../src/node/server.mjs");
    const { url } = await startRenderServer(config, { port: 5173 });
    console.log(`diagrams on ${url}`);
    break;
  }
  case "site": {
    const { buildSite, devSite } = await import("../src/node/site.mjs");
    if (sub === "build") await buildSite(config, dir ?? "dist-docs");
    else if (sub === "dev") await devSite(config);
    else usage();
    break;
  }
  default:
    usage();
}

function usage() {
  console.error("usage: in-ctrl render [--all] | check | dev | site build [DIR] | site dev   [--root DIR]");
  process.exit(2);
}
