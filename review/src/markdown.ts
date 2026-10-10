// <repo-markdown file="TODO.md">: a markdown file from the repo, rendered by
// `in-ctrl review gen`.

export class RepoMarkdown extends HTMLElement {
  async connectedCallback() {
    if (this.dataset.rendered) return;
    this.dataset.rendered = "1";
    const files: Record<string, string> = (await import("/generated/markdown.json")).default;
    const file = this.getAttribute("file") ?? "";
    this.innerHTML = files[file] ?? `<p class="muted">${file} wasn't rendered; run in-ctrl review gen.</p>`;

    for (const code of this.querySelectorAll<HTMLElement>("pre > code")) {
      const rawHtml = code.innerHTML;
      const lines = rawHtml.split("\n");
      const firstText = lines[0]?.replace(/<[^>]+>/g, "").trim() ?? "";
      const fileMatch = firstText.match(/^(?:#|\/\/|--)\s*([\w./-]+)/);
      if (fileMatch) code.parentElement?.setAttribute("data-file", fileMatch[1]);
      const lastEmpty = lines.length > 0 && lines[lines.length - 1] === "";
      const count = lastEmpty ? lines.length - 1 : lines.length;
      code.innerHTML = lines
        .slice(0, count)
        .map((lineHtml, i) => `<span class="code-line" data-line="${i + 1}">${lineHtml || " "}</span>\n`)
        .join("");
    }

    // Page review collects commentable blocks once this content is in.
    this.dataset.done = "1";
    this.dispatchEvent(new CustomEvent("markdown:rendered", { bubbles: true }));
  }
}
