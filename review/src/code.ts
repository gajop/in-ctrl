// <review-code branch="…">: all of a branch's code, in one of two views:
//   Walkthrough — the element's own content in reading order: prose, with
//     <walk-file file="…" symbol="a, b" match="text"> where a diff goes.
//     `symbol` shows only hunks inside those functions (`match="text"`: hunks
//     mentioning them). A hunk shows once; what no walk-file shows follows
//     under "Remaining changes", so the walkthrough covers everything.
//   All files — every file's diff in path order.
// The bar holds the view switch and the settings for every diff (notes,
// layout, whitespace), and can keep the branch overview in view; a file tree
// links to each file. Scrolling one diff sideways scrolls them all.

import { inline } from "./glance";
import { type BranchData, type Hunk, loadBranch, pages } from "./data";
import { type FileEntry, activeHunks, escapeHtml, fileAnchor, hunksFor, renderFileDiff } from "./diff";
import { noteLevelControl } from "./notes";
import {
  type CodeView,
  type NoteLevel,
  codeView,
  comments,
  diffMode,
  isReviewed,
  patchHash,
  setCodeView,
  setDiffMode,
  setNoteLevel,
  setShowWhitespace,
  showWhitespace,
  store,
} from "./store";

export class ReviewCode extends HTMLElement {
  async connectedCallback() {
    if (this.dataset.rendered) return;
    this.dataset.rendered = "1";
    const story = [...this.childNodes];
    const hasStory = story.some((n) => n instanceof Element);
    this.replaceChildren();
    const data = await loadBranch(this.getAttribute("branch")!);
    if (!data) return;

    // The bar stays at the top while the code scrolls: the controls, and the
    // branch overview (the page's TL;DR) when the reader keeps it open.
    const bar = document.createElement("div");
    bar.className = "code-bar";
    const row = document.createElement("div");
    row.className = "code-bar-row";
    const overview = document.createElement("div");
    overview.className = "code-overview";
    overview.append(...overviewContent(data));
    bar.append(row, overview);
    const tree = document.createElement("nav");
    tree.className = "file-tree";
    const body = document.createElement("div");
    body.className = "code-body";
    const layout = document.createElement("div");
    layout.className = "changes-layout";
    layout.append(tree, body);
    this.replaceChildren(bar, layout);

    const view = (): CodeView => (hasStory ? codeView() : "files");
    // The tree starts open in All files and closed in the walkthrough, which is read top to bottom.
    const treeOpen: Record<CodeView, boolean> = { walkthrough: false, files: true };
    const renderBody = () => {
      body.replaceChildren(...(view() === "walkthrough" ? walkthrough(data, story) : allFiles(data)));
      layout.classList.toggle("tree-hidden", !treeOpen[view()]);
    };
    const renderBar = () => {
      overview.hidden = !overview.childNodes.length;
      row.innerHTML = `
        ${hasStory ? segmented("view", [["walkthrough", "Walkthrough"], ["files", "All files"]], view()) : ""}
        <button type="button" class="tree-toggle${treeOpen[view()] ? " active" : ""}" title="File tree">Files</button>
        <span class="changes-count"></span>
        <span class="spacer"></span>
        ${noteLevelControl(data.name)}
        ${segmented("layout", [["unified", "Unified"], ["split", "Split"]], diffMode())}
        <label class="ws-toggle" title="Show changes that only touch whitespace"><input type="checkbox" ${showWhitespace() ? "checked" : ""}> Whitespace</label>`;
      row.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((b) =>
        b.addEventListener("click", () => setCodeView(b.dataset.view as CodeView)),
      );
      row.querySelectorAll<HTMLButtonElement>("[data-layout]").forEach((b) =>
        b.addEventListener("click", () => setDiffMode(b.dataset.layout as "unified" | "split")),
      );
      row.querySelectorAll<HTMLButtonElement>("[data-note-level]").forEach((b) =>
        b.addEventListener("click", () => setNoteLevel(b.dataset.noteLevel as NoteLevel)),
      );
      row.querySelector(".tree-toggle")!.addEventListener("click", () => {
        treeOpen[view()] = !treeOpen[view()];
        layout.classList.toggle("tree-hidden", !treeOpen[view()]);
        renderBar();
        renderTree();
      });
      row.querySelector<HTMLInputElement>(".ws-toggle input")!.addEventListener("change", (e) =>
        setShowWhitespace((e.target as HTMLInputElement).checked),
      );
      renderTree();
    };
    const renderTree = () => {
      // Keep folders the reader closed closed across re-renders.
      const closed = new Set(
        [...tree.querySelectorAll<HTMLDetailsElement>("details:not([open])")].map((d) => d.dataset.path),
      );
      tree.innerHTML = treeHtml(buildTree(data.files), data);
      for (const d of tree.querySelectorAll<HTMLDetailsElement>("details")) if (closed.has(d.dataset.path)) d.open = false;
      const done = data.files.filter((f) => isReviewed(data.name, f.file, patchHash(f.hunks))).length;
      row.querySelector(".changes-count")!.textContent = `${done}/${data.files.length} reviewed`;
    };

    tree.addEventListener("click", (e) => {
      const link = (e.target as Element).closest<HTMLAnchorElement>("a[data-file]");
      if (!link) return;
      e.preventDefault();
      const section = document.getElementById(fileAnchor(data.name, link.dataset.file!));
      if (section?.classList.contains("collapsed")) section.querySelector<HTMLButtonElement>(".collapse")?.click();
      document.getElementById(fileAnchor(data.name, link.dataset.file!))?.scrollIntoView({ block: "start" });
    });
    const onChange = (e: Event) => {
      if (!this.isConnected && this.dataset.mounted) return store.removeEventListener("change", onChange);
      const key = (e as CustomEvent<string>).detail;
      if (key === "codeView" || key === "showWhitespace") renderBody();
      if (["codeView", "diffMode", "showWhitespace", "noteLevel", "overviewOpen"].includes(key)) renderBar();
      else if (key === "reviewed" || key === "comments") renderTree();
    };
    store.addEventListener("change", onChange);
    queueMicrotask(() => (this.dataset.mounted = "1"));
    renderBody();
    renderBar();
  }
}

// Helpers

/** The authored story with each <walk-file> filled in, then the hunks it didn't show. */
function walkthrough(data: BranchData, story: Node[]): Node[] {
  const shownBy = new Map<string, ((hunks: Hunk[]) => Hunk[])[]>();
  const walkFiles = story.flatMap((n) =>
    n instanceof Element ? [...(n.matches("walk-file") ? [n] : []), ...n.querySelectorAll("walk-file")] : [],
  );
  for (const el of walkFiles) {
    const path = el.getAttribute("file") ?? "";
    const entry = data.files.find((f) => f.file === path);
    if (!entry) {
      el.innerHTML = `<div class="diff missing">No changes to <code>${escapeHtml(path)}</code> in this branch.</div>`;
      continue;
    }
    const symbols = (el.getAttribute("symbol") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const byText = el.getAttribute("match") === "text";
    const earlier = shownBy.get(path) ?? [];
    const select = (hunks: Hunk[]) => {
      const taken = new Set(earlier.flatMap((s) => s(hunks)));
      return (symbols.length ? hunksFor(entry, hunks, symbols, byText) : hunks).filter((h) => !taken.has(h));
    };
    shownBy.set(path, [...earlier, select]);
    const first = earlier.length === 0;
    if (!first && !select(activeHunks(entry)).length) {
      el.innerHTML = `<div class="diff shown-above">Shown above: <a href="#${fileAnchor(data.name, path)}"><code>${escapeHtml(path)}</code></a></div>`;
      continue;
    }
    el.replaceChildren(
      renderFileDiff({ branch: data, file: entry, select, anchor: first, orphanNotes: first, label: symbols.join(", ") || undefined }),
    );
  }

  const rest: HTMLElement[] = [];
  for (const entry of data.files) {
    const shown = shownBy.get(entry.file);
    if (!shown) {
      rest.push(renderFileDiff({ branch: data, file: entry }));
      continue;
    }
    const select = (hunks: Hunk[]) => {
      const taken = new Set(shown.flatMap((s) => s(hunks)));
      return hunks.filter((h) => !taken.has(h));
    };
    if (select(activeHunks(entry)).length) {
      rest.push(renderFileDiff({ branch: data, file: entry, select, anchor: false, orphanNotes: false, label: "rest of file" }));
    }
  }
  if (!rest.length) return story;
  const heading = document.createElement("h3");
  heading.className = "remaining";
  heading.textContent = "Remaining changes";
  return [...story, heading, ...rest];
}

/** The page's one-liner, kept in view above the code: what all of this is for. */
function overviewContent(_data: BranchData): Node[] {
  const page = pages.find((p) => p.path === location.pathname);
  if (!page?.oneliner) return [];
  const line = document.createElement("div");
  line.className = "overview-title";
  line.innerHTML = inline(page.oneliner);
  return [line];
}

function allFiles(data: BranchData): HTMLElement[] {
  return [...data.files]
    .sort((a, b) => a.file.localeCompare(b.file))
    .map((f) => renderFileDiff({ branch: data, file: f }));
}

function segmented(name: string, options: [string, string][], current: string): string {
  return `<span class="segmented">${options
    .map(([value, label]) => `<button type="button" data-${name}="${value}" class="${value === current ? "active" : ""}">${label}</button>`)
    .join("")}</span>`;
}

interface TreeDir {
  name: string;
  dirs: Map<string, TreeDir>;
  files: FileEntry[];
}

function buildTree(files: FileEntry[]): TreeDir {
  const root: TreeDir = { name: "", dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.file.split("/");
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      if (!dir.dirs.has(part)) dir.dirs.set(part, { name: part, dirs: new Map(), files: [] });
      dir = dir.dirs.get(part)!;
    }
    dir.files.push(f);
  }
  return compress(root);
}

/** Merge folders that only contain one folder (`crates/core/src`), like code hosts do. */
function compress(dir: TreeDir): TreeDir {
  for (const [key, child] of dir.dirs) {
    let merged = child;
    while (merged.files.length === 0 && merged.dirs.size === 1) {
      const [only] = merged.dirs.values();
      merged = { ...only, name: `${merged.name}/${only.name}` };
    }
    dir.dirs.set(key, compress(merged));
  }
  return dir;
}

function treeHtml(dir: TreeDir, data: BranchData, prefix = ""): string {
  const folders = [...dir.dirs.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((d) => {
      const path = `${prefix}${d.name}/`;
      return `<details open data-path="${escapeHtml(path)}"><summary>${escapeHtml(d.name)}</summary>${treeHtml(d, data, path)}</details>`;
    })
    .join("");
  const mine = comments().filter((c) => c.branch === data.name);
  const files = [...dir.files]
    .sort((a, b) => a.file.localeCompare(b.file))
    .map((f) => {
      const reviewed = isReviewed(data.name, f.file, patchHash(f.hunks));
      const count = mine.filter((c) => c.file === f.file).length;
      const status = f.status === "A" ? "added" : f.status === "D" ? "deleted" : "modified";
      const lines = activeHunks(f).flatMap((h) => h.lines);
      const added = lines.filter((l) => l[0] === "+").length;
      const removed = lines.filter((l) => l[0] === "-").length;
      return `<a href="#${fileAnchor(data.name, f.file)}" data-file="${escapeHtml(f.file)}" class="tree-file ${status}${reviewed ? " reviewed" : ""}">
        <span class="check">${reviewed ? "✓" : ""}</span><span class="fname">${escapeHtml(f.file.split("/").at(-1)!)}</span>
        ${count ? `<span class="ccount">💬${count}</span>` : ""}
        ${added || removed ? `<span class="added">+${added}</span><span class="removed">−${removed}</span>` : `<span class="muted">ws</span>`}</a>`;
    })
    .join("");
  return folders + files;
}
