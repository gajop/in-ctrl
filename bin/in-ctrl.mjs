#!/usr/bin/env node
// in-ctrl: docs you stay in control of.
//
//   in-ctrl render [--all]      draw the diagrams that changed into their PNGs
//   in-ctrl check               fail if a PNG is missing or stale, or an icon unknown
//   in-ctrl dev                 every diagram, light and dark, in the browser
//   in-ctrl site build [DIR]    the docs site (default DIR: dist-docs)
//   in-ctrl site dev            the docs site, live, with comments
//   in-ctrl site serve [DIR]    a built site over HTTP: its 404 page, site.redirects, comments
//                               (--host HOST, default 127.0.0.1; --port PORT, default 8080;
//                               --comments FILE, default the config's; --no-comments)
//   in-ctrl comments [--all]    the open comment threads (--all: resolved too), as Markdown
//   in-ctrl comments reply ID TEXT [--as NAME]
//                               answer a thread (ID: a comment's id, or its start)
//
// Options: --root DIR (the project; default: the current directory).

import path from "node:path";
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
const host = option("--host");
const port = option("--port");
const dirOption = option("--dir");
const commentsOption = option("--comments");
const as = option("--as");
const all = args.includes("--all");
const positional = args.filter((a) => !a.startsWith("--"));
const config = loadConfig(root);
if (commentsOption) config.comments = path.resolve(commentsOption);
if (args.includes("--no-comments")) config.comments = null;
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
    else if (sub === "serve") {
      const { serveSite } = await import("../src/node/serve.mjs");
      await serveSite(config, dirOption ?? dir ?? "dist-docs", { host: host ?? "127.0.0.1", port: port ? Number(port) : 8080 });
    } else usage();
    break;
  }
  case "comments": {
    const { readComments, report, reply } = await import("../src/node/comments.mjs");
    if (!config.comments) fail("comments are turned off (comments: false in in-ctrl.config.yaml)");
    if (sub === "reply") {
      const [, , id, ...words] = positional;
      if (!id) fail("usage: in-ctrl comments reply ID TEXT [--as NAME]");
      try {
        const answer = reply(config.comments, id, words.join(" "), as ?? "agent");
        console.log(`replied in the thread of ${answer.thread.slice(0, 8)}`);
      } catch (err) {
        fail(err.message);
      }
    } else if (!sub) console.log(report(readComments(config.comments), { includeResolved: all }));
    else usage();
    break;
  }
  default:
    usage();
}

function fail(message) {
  console.error(`in-ctrl: ${message}`);
  process.exit(1);
}

function usage() {
  console.error(
    "usage: in-ctrl render [--all] | check | dev | site build [DIR] | site dev | site serve [DIR] [--host H] [--port P] [--comments FILE | --no-comments]\n" +
      "       | comments [--all] | comments reply ID TEXT [--as NAME]   [--root DIR]",
  );
  process.exit(2);
}
