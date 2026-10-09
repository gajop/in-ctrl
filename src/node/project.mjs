// The Vite plugin that hands a project's diagrams to the browser: the virtual
// module "virtual:in-ctrl/project" exports { specs, icons, vocabulary }, with
// `specs` keyed by path relative to the project root.

import fs from "node:fs";
import path from "node:path";
import { diagramSources } from "./config.mjs";
import { buildIcons } from "./icons.mjs";

const ID = "virtual:in-ctrl/project";

export function projectPlugin(config) {
  return {
    name: "in-ctrl-project",
    resolveId: (id) => (id === ID ? `\0${ID}` : undefined),
    load(id) {
      if (id !== `\0${ID}`) return undefined;
      const specs = Object.fromEntries(diagramSources(config).map((f) => [path.relative(config.root, f), fs.readFileSync(f, "utf8")]));
      const icons = buildIcons([...Object.values(specs), JSON.stringify(config.vocabulary)]);
      return `export const specs = ${JSON.stringify(specs)};\nexport const icons = ${JSON.stringify(icons)};\nexport const vocabulary = ${JSON.stringify(config.vocabulary)};\n`;
    },
  };
}
