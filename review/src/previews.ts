// <doc-previews>: the docs pages the page's branch changes, each as a link to
// the docs site before and after the branch (built by scripts/build-previews.mjs
// and served by the guide under /previews/).

import previewsJson from "/generated/previews.json";
import { pages } from "./data";
import { escapeHtml } from "./diff";

interface Preview { base: string; before: string; after: string; pages: { file: string; path: string }[] }
const previews = previewsJson as Record<string, Preview>;

export class DocPreviews extends HTMLElement {
  connectedCallback() {
    const branch = this.getAttribute("branch") ?? pages.find((p) => p.path === location.pathname)?.branch ?? "";
    const preview = previews[branch];
    if (!preview) {
      // `auto`: on every review page; only shown when the branch changes docs.
      if (this.hasAttribute("auto")) {
        this.hidden = true;
        return;
      }
      this.innerHTML = `<p class="muted">No docs-site preview for ${escapeHtml(branch)}.</p>`;
      return;
    }
    const rows = preview.pages
      .map(
        (p) =>
          `<tr><td><code>${escapeHtml(p.file)}</code></td><td><a href="${preview.before}${p.path}" target="_blank">before</a></td><td><a href="${preview.after}${p.path}" target="_blank">after</a></td></tr>`,
      )
      .join("");
    const heading = this.hasAttribute("auto") ? `<h2 id="docs-pages">The docs pages this changes</h2>` : "";
    this.innerHTML = `${heading}<p>The docs site as readers will see it, built with in-ctrl: <strong>before</strong> is <code>${escapeHtml(preview.base)}</code>, <strong>after</strong> is this branch.</p>
<table><thead><tr><th>Page</th><th>Before</th><th>After</th></tr></thead><tbody>${rows}</tbody></table>`;
  }
}
