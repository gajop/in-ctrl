// On every page: draw the live diagrams (<div class="in-ctrl-diagram" data-file>)
// in Starlight's current theme, and redraw when the reader switches it. Each
// draws in a shadow root, so the page's content styles (margins, svg sizing)
// don't reach into it.

import flowCss from "@xyflow/react/dist/style.css?inline";
import { createRoot, type Root } from "react-dom/client";
import diagramCss from "../../src/diagram/diagram.css?inline";
import YAML from "yaml";
// @ts-expect-error: a virtual module, provided by src/node/project.mjs
import { icons, specs, vocabulary } from "virtual:in-ctrl/project";
import { Diagram, type DiagramSpec, type Theme, addIcons, setVocabulary } from "../../src/diagram";

addIcons(icons);
setVocabulary(vocabulary);

const roots = new Map<HTMLElement, Root>();
const theme = (): Theme => (document.documentElement.dataset.theme === "dark" ? "dark" : "light");

function draw() {
  for (const host of document.querySelectorAll<HTMLElement>(".in-ctrl-diagram")) {
    const source = (specs as Record<string, string>)[host.dataset.file ?? ""];
    if (!source) {
      // No live source for it (renamed, or not part of this build): show the
      // rendered PNG instead of an empty box, on a light backdrop (styles.css).
      if (host.dataset.png && !host.querySelector("img")) {
        const img = document.createElement("img");
        img.className = "in-ctrl-png";
        img.src = host.dataset.png;
        img.alt = "";
        host.append(img);
      }
      continue;
    }
    let root = roots.get(host);
    if (!root) {
      const shadow = host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = `${flowCss}\n${diagramCss}\n:host { display: block; }`;
      const mount = document.createElement("div");
      shadow.append(style, mount);
      root = createRoot(mount);
      roots.set(host, root);
    }
    root.render(<Diagram spec={YAML.parse(source) as DiagramSpec} theme={theme()} />);
  }
}

draw();
document.addEventListener("astro:page-load", draw);
new MutationObserver(draw).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
