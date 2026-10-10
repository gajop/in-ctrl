// <branch-flows>: the repository's docs diagrams that the page's branch
// changes, each drawn by <docs-diagram> with Unified / Before / After tabs.
// The diagrams come from the branch itself (gen-data.mjs `diagrams`), so the
// review shows the flows as the branch leaves them. Renders nothing when the
// branch changes no diagram.

import { loadBranch, pages } from "./data";
import { escapeHtml } from "./diff";

interface BranchDiagram { file: string; before: string | null; after: string | null }

export class BranchFlows extends HTMLElement {
  async connectedCallback() {
    const branch = this.getAttribute("branch") ?? pages.find((p) => p.path === location.pathname)?.branch ?? "";
    const data = (await loadBranch(branch)) as { diagrams?: BranchDiagram[] } | null;
    const diagrams = (data?.diagrams ?? []).filter((d) => d.after);
    if (!diagrams.length) {
      this.hidden = true;
      return;
    }
    const sections = diagrams
      .map((d) => {
        const title = /^title:\s*(.+)$/m.exec(d.after ?? "")?.[1]?.replace(/^["']|["']$/g, "") ?? d.file;
        const before = d.before === null ? "" : `<script type="application/yaml" data-before>${escapeScript(d.before)}</script>`;
        const note = d.before === null ? ` <span class="muted">(new)</span>` : "";
        return `<h3>${escapeHtml(title)}${note}</h3><p class="muted"><code>${escapeHtml(d.file)}</code></p><docs-diagram file="${escapeHtml(d.file)}"><script type="application/yaml">${escapeScript(d.after ?? "")}</script>${before}</docs-diagram>`;
      })
      .join("");
    this.innerHTML = `<h2 id="flows">The flows this changes</h2><p>The developer docs' diagrams this branch changes, as a unified diff (<strong>+</strong> added, <strong>−</strong> removed, <strong>~</strong> changed), or before and after. They are part of the branch, so you review them here too.</p>${sections}`;
  }
}

/** Text inside a <script> element: only `</script` would end it early. */
function escapeScript(text: string): string {
  return text.replace(/<\/script/gi, "<\\/script");
}
