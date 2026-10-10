import { highlight } from "./diff";
import "highlight.js/styles/github.css";
import "./styles.css";
import { ReviewCode } from "./code";
import { SysGraph } from "./graph";
import { RepoMarkdown } from "./markdown";
import { GuideNav } from "./nav";
import { ReviewNotes, installCommentsPanel } from "./notes";
import { CodeRef, ReviewHeader } from "./review";
import { GlanceLegend, ProjectMaps, ReviewList, ReviewSummary } from "./glance";
import { installRouter } from "./router";
import { SeqFlow } from "./sequence";
import { BranchFlows } from "./branch-flows";
import { DocPreviews } from "./previews";
import { installSourceLinks } from "./source";
import { installLive } from "./live";
import { installPageReview } from "./page-review";
import { installCommentMinimap } from "./minimap";
import { loadReview } from "./sync";
import { applyTheme } from "./theme";

applyTheme();
await loadReview();

customElements.define("guide-nav", GuideNav);
customElements.define("sys-graph", SysGraph);
customElements.define("seq-flow", SeqFlow);
// Architecture and deployment diagrams (in-ctrl's: React Flow + ELK).
customElements.define(
  "docs-diagram",
  class extends HTMLElement {
    connectedCallback() {
      void import("./docs-diagram").then((m) => this.isConnected && m.mountDiagram(this));
    }
    disconnectedCallback() {
      void import("./docs-diagram").then((m) => m.unmountDiagram(this));
    }
  },
);
customElements.define("code-ref", CodeRef);
customElements.define("doc-previews", DocPreviews);
customElements.define("branch-flows", BranchFlows);
customElements.define("review-header", ReviewHeader);
customElements.define("glance-legend", GlanceLegend);
customElements.define("review-list", ReviewList);
customElements.define("review-summary", ReviewSummary);
customElements.define("project-maps", ProjectMaps);
customElements.define("review-notes", ReviewNotes);
customElements.define("review-code", ReviewCode);
customElements.define("repo-markdown", RepoMarkdown);

// The project's own elements (review.client), defined before the page's elements upgrade.
await import("virtual:in-ctrl-review-client");

installRouter();
installCommentsPanel();
installCommentMinimap();
installSourceLinks();
installPageReview();
installLive();

// Code blocks on pages and in repo markdown (```yaml …) get syntax colours.
const ALIASES: Record<string, string> = { sh: "bash", shell: "bash", console: "bash", yml: "yaml", py: "python", rs: "rust", ts: "typescript", js: "typescript" };
function highlightCode(root: ParentNode = document) {
  for (const code of root.querySelectorAll<HTMLElement>('main pre code[class*="language-"]:not(.hljs)')) {
    const name = /language-(\S+)/.exec(code.className)?.[1] ?? "";
    const language = ALIASES[name] ?? name;
    if (!["bash", "json", "python", "rust", "sql", "typescript", "yaml"].includes(language)) continue;
    code.innerHTML = highlight(code.textContent ?? "", language);
    code.classList.add("hljs");
  }
}
highlightCode();
document.addEventListener("guide:page", () => highlightCode());

// "Checked" lists are evidence, not the story: folded by default behind a
// count. A "Not checked" item isn't a check, so it moves out of the list.
function foldChecked(root: ParentNode = document) {
  for (const list of root.querySelectorAll<HTMLUListElement>("main ul.checked")) {
    if (list.closest("details.checked-box")) continue;
    const heading = list.previousElementSibling?.tagName === "H2" ? (list.previousElementSibling as HTMLElement) : null;
    const notChecked = [...list.querySelectorAll(":scope > li")].filter((li) => /^\s*not checked\b/i.test(li.textContent ?? ""));
    for (const li of notChecked) li.remove();
    const items = list.querySelectorAll(":scope > li:not(:empty)").length;
    const box = document.createElement("details");
    box.className = "checked-box";
    box.innerHTML = `<summary>✓ Checked · ${items} item${items === 1 ? "" : "s"}</summary>`;
    list.replaceWith(box);
    box.append(list);
    heading?.remove();
    for (const li of notChecked) {
      const p = document.createElement("p");
      p.className = "not-checked";
      p.innerHTML = li.innerHTML.replace(/^\s*(<strong>)?\s*not checked:?\s*(<\/strong>)?:?\s*/i, "<strong>Not checked:</strong> ");
      box.after(p);
    }
  }
}
foldChecked();
document.addEventListener("guide:page", () => foldChecked());

// Screenshots open in a lightbox on the page; a click or Escape closes it.
document.addEventListener("click", (e) => {
  const img = (e.target as HTMLElement).closest<HTMLImageElement>(".shots img");
  if (!img) return;
  const box = document.createElement("div");
  box.className = "lightbox";
  box.innerHTML = `<img src="${img.src}" alt="${img.alt}">`;
  const close = () => {
    box.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (k: KeyboardEvent) => k.key === "Escape" && close();
  box.addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  document.body.append(box);
});
document.addEventListener("markdown:rendered", (e) => highlightCode(e.target as HTMLElement));
