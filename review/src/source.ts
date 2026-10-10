// The code viewer: code references (<code-ref>, diagram boxes and arrows)
// open the file in a panel on the page, scrolled to the referenced line.
// The text comes from generated/sources (the files as they are on the guide's
// branch). On a computer the panel also links to the file in the editor.

import { coarsePointer, editorHref, refs } from "./data";
import { escapeHtml, highlight, languageFor } from "./diff";

/** Open the panel at a ref (`path#symbol`); does nothing for unresolved refs. */
export async function openSource(ref: string) {
  const info = refs[ref];
  if (!info?.ok || info.line === null) return;
  const loader = sourceLoaders[`/generated/sources/${info.file.replaceAll("/", "__")}.json`];
  if (!loader) return;
  const panel = viewer();
  const editor = coarsePointer ? null : editorHref(ref);
  panel.head.innerHTML = `<code class="source-path">${escapeHtml(info.file)}:${info.line}</code>
    <span class="spacer"></span>
    ${editor ? `<a class="source-editor" href="${escapeHtml(editor)}" title="Open in your editor">Open in VS Code</a>` : ""}
    <button type="button" class="source-close" title="Close (Esc)">✕</button>`;
  panel.head.querySelector(".source-close")!.addEventListener("click", closeSource);
  panel.body.replaceChildren();
  panel.root.hidden = false;
  const { text } = (await loader()) as { file: string; text: string };
  const lines = text.replace(/\n$/, "").split("\n");
  const language = languageFor(info.file);
  panel.body.innerHTML = `<div class="source-lines">
      <pre class="source-gutter">${lines.map((_, i) => i + 1).join("\n")}</pre>
      <pre class="source-code"><div class="source-mark" style="top:calc(${info.line - 1} * var(--source-line))"></div><code class="hljs">${highlight(text, language)}</code></pre>
    </div>`;
  const mark = panel.body.querySelector<HTMLElement>(".source-mark")!;
  panel.body.scrollTop = Math.max(0, mark.offsetTop - panel.body.clientHeight / 3);
}

export function closeSource() {
  const root = document.querySelector<HTMLElement>(".source-viewer");
  if (root) root.hidden = true;
}

/** Clicks on any element with `data-ref` open the viewer (also in copied content, like the code bar's overview). */
export function installSourceLinks() {
  document.addEventListener("click", (e) => {
    const link = (e.target as Element).closest<HTMLElement>("[data-ref]");
    if (!link) return;
    e.preventDefault();
    void openSource(link.dataset.ref!);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeSource();
  });
  document.addEventListener("guide:page", closeSource);
}

// Helpers

const sourceLoaders = import.meta.glob("/generated/sources/*.json", { import: "default" });

function viewer(): { root: HTMLElement; head: HTMLElement; body: HTMLElement } {
  let root = document.querySelector<HTMLElement>(".source-viewer");
  if (!root) {
    root = document.createElement("div");
    root.className = "source-viewer";
    root.hidden = true;
    root.innerHTML = `<div class="source-head"></div><div class="source-body"></div>`;
    document.body.append(root);
  }
  return {
    root,
    head: root.querySelector<HTMLElement>(".source-head")!,
    body: root.querySelector<HTMLElement>(".source-body")!,
  };
}
