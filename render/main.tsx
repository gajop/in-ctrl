// The page `in-ctrl dev` and `in-ctrl render` open. Without a query it shows
// every diagram of the project in both themes; `?file=<path>&theme=light&fixed=1`
// shows one at 100%, which the renderer screenshots into the PNG next to it.

import "@xyflow/react/dist/style.css";
import "../src/diagram/diagram.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import YAML from "yaml";
// @ts-expect-error: a virtual module, provided by src/node/project.mjs
import { icons, specs, vocabulary } from "virtual:in-ctrl/project";
import { Diagram, type DiagramSpec, type Theme, addIcons, setVocabulary } from "../src/diagram";

addIcons(icons);
setVocabulary(vocabulary);
const byFile = specs as Record<string, string>;
const params = new URLSearchParams(location.search);
const file = params.get("file");
const root = document.getElementById("root")!;

if (file) {
  const theme = (params.get("theme") ?? "light") as Theme;
  root.className = "fixed";
  createRoot(root).render(
    <StrictMode>
      <Diagram spec={YAML.parse(byFile[file]) as DiagramSpec} theme={theme} fixed />
    </StrictMode>,
  );
} else {
  createRoot(root).render(
    <StrictMode>
      <div className="page">
        {Object.entries(byFile).map(([path, text]) => (
          <section key={path}>
            <h2>{path}</h2>
            {(["light", "dark"] as Theme[]).map((t) => (
              <Diagram key={t} spec={YAML.parse(text) as DiagramSpec} theme={t} />
            ))}
          </section>
        ))}
      </div>
    </StrictMode>,
  );
}
