import { marked } from "marked";
// Renders one file's diff: unified or split, with or without whitespace-only
// changes, with review notes (annotations written by the page author) and the
// reader's own comments inline.
//
// Notes come from <review-notes branch="…"> elements on the page:
//   - { kind: important|detail|…, file: path, at: "text on the line", text: "…" }
//   `line: N` (new-file line) can replace `at`; `side: old` anchors on a removed
//   line. A note whose anchor isn't in any hunk sits on the file's first line.

import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import yaml from "highlight.js/lib/languages/yaml";
import YAML from "yaml";
import { type BranchData, type Hunk, meta } from "./data";
import {
  type ReviewComment,
  addComment,
  comments,
  diffMode,
  isResolved,
  isReviewed,
  noteShown,
  patchHash,
  setReviewed,
  showWhitespace,
  store,
  threadKey,
  threadsOf,
} from "./store";
import { composerEl, composing, openComposer, replyDraftKey, threadEl, threadVisible } from "./thread";

for (const [name, lang] of Object.entries({ bash, json, python, rust, sql, typescript, yaml })) {
  hljs.registerLanguage(name, lang);
}

export type FileEntry = BranchData["files"][number];

export interface ReviewNote {
  kind: string;
  file?: string;
  at?: string;
  line?: number;
  side?: "old" | "new";
  text: string;
}

export interface FileDiffOptions {
  branch: BranchData;
  file: FileEntry;
  /** Picks the hunks to show (an excerpt) from the file's current hunks; defaults to all. */
  select?: (hunks: Hunk[]) => Hunk[];
  /** Also show notes whose anchor isn't in any hunk; defaults to true without `select`. */
  orphanNotes?: boolean;
  /** Give the section the file's anchor id (the file tree links to it). */
  anchor?: boolean;
  label?: string;
}

/** A file's diff section; re-renders itself when settings, comments or review marks change. */
export function renderFileDiff(opts: FileDiffOptions): HTMLElement {
  const section = document.createElement("section");
  section.className = "file-diff";
  if (opts.anchor ?? true) section.id = fileAnchor(opts.branch.name, opts.file.file);
  // Reviewed marks follow the full patch, whatever the whitespace setting.
  const hash = patchHash(opts.file.hunks);
  let collapsed = isReviewed(opts.branch.name, opts.file.file, hash);
  let preview = false;

  const render = () => {
    drawn = fileSignature();
    const reviewed = isReviewed(opts.branch.name, opts.file.file, hash);
    const all = activeHunks(opts.file);
    const shown = opts.select ? opts.select(all) : all;
    section.classList.toggle("reviewed", reviewed);
    section.classList.toggle("collapsed", collapsed);
    section.replaceChildren(header(opts, all, reviewed, collapsed, hash, (c) => ((collapsed = c), render())));
    if (opts.file.preview !== undefined) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "preview-toggle" + (preview ? " on" : "");
      toggle.textContent = preview ? "Diff" : "Preview";
      toggle.title = preview ? "Show the diff" : "Show the file rendered, as the branch leaves it";
      toggle.onclick = () => {
        preview = !preview;
        render();
      };
      section.querySelector(".file-head .spacer")?.after(toggle);
    }
    if (collapsed) return;
    if (preview && opts.file.preview !== undefined) {
      section.append(markdownPreview(opts.file.preview));
      return;
    }
    const lines = shown.map(parseHunk);
    const notes = notesFor(opts.branch.name, opts.file.file).filter((n) => noteShown(n.kind));
    const placed = placeNotes(notes, lines);
    const anywhere = opts.select ? placeNotes(notes, all.map(parseHunk)) : placed;
    const orphans = (opts.orphanNotes ?? !opts.select) ? notes.filter((n) => !anywhere.has(n)) : [];
    const firstLine = lines.flat()[0];
    if (firstLine) for (const n of orphans) placed.set(n, firstLine);
    const fileThreads = threadsOf(
      comments().filter((c) => c.branch === opts.branch.name && c.file === opts.file.file && !c.line),
    ).filter(threadVisible);
    const { anchorOf, loose } = anchorLineThreads(opts, lines.flat());
    const fileNotes = firstLine ? [] : orphans;
    if (fileThreads.length || fileNotes.length || loose.length) {
      const box = document.createElement("div");
      box.className = "file-notes";
      for (const [i, list] of (fileThreads.length ? fileThreads : [[]]).entries()) {
        const thread: HTMLElement = threadEl(i === 0 ? fileNotes : [], list, () =>
          openComposer(
            thread,
            (text) => addComment({ branch: opts.branch.name, file: opts.file.file, thread: list[0]?.thread, text }, list.length > 0),
            undefined,
            list.length ? replyDraftKey(threadKey(list[0])) : `new|${opts.branch.name}|${opts.file.file}`,
          ),
        );
        box.append(thread);
      }
      // Line comments whose line isn't in this diff any more (the branch changed since): shown here, with the code they were on.
      for (const list of loose) {
        const c = list[0];
        const label = document.createElement("div");
        label.className = "loose-label";
        label.innerHTML = `Line ${c.startLine && c.startLine !== c.line ? `${c.startLine}-${c.line}` : c.line}, no longer in this diff${c.code ? `:<pre>${escapeHtml(c.code)}</pre>` : ""}`;
        const thread: HTMLElement = threadEl([], list, () =>
          openComposer(
            thread,
            (text) =>
              addComment({ branch: c.branch, file: c.file, line: c.line, startLine: c.startLine, side: c.side, code: c.code, thread: c.thread, text }, true),
            undefined,
            replyDraftKey(threadKey(c)),
          ),
        );
        thread.prepend(label);
        box.append(thread);
      }
      if (!fileThreads.length && !fileNotes.length && loose.length) box.firstElementChild?.remove();
      section.append(box);
    }
    if (!all.length) {
      const empty = document.createElement("div");
      empty.className = "diff-empty";
      empty.textContent = "Only whitespace changes.";
      section.append(empty);
    }
    const language = languageFor(opts.file.file);
    // A new or deleted file has only one side; split would be half empty.
    const mode = opts.file.status === "A" || opts.file.status === "D" ? "unified" : diffMode();
    shown.forEach((h, i) => section.append(renderHunk(h, lines[i], mode, language, placed, opts, anchorOf)));
  };

  let stale = false;
  const fileSignature = () =>
    JSON.stringify([
      isReviewed(opts.branch.name, opts.file.file, hash),
      comments()
        .filter((c) => c.branch === opts.branch.name && c.file === opts.file.file)
        .map((c) => [c.id, c.text, c.edited ?? "", isResolved(threadKey(c))]),
    ]);
  let drawn = "";
  const onChange = (e: Event) => {
    if (!section.isConnected && section.dataset.mounted) {
      store.removeEventListener("change", onChange);
      return;
    }
    const key = (e as CustomEvent<string>).detail;
    if (["diffMode", "showWhitespace", "noteLevel", "showResolved"].includes(key)) stale = true;
    // Comments, reviewed marks and resolved threads change for the whole
    // review; redraw only when this file's part changed, so the page doesn't
    // shift under the reader when a reply lands elsewhere.
    if (["comments", "reviewed", "resolved"].includes(key)) {
      const next = fileSignature();
      if (next !== drawn) stale = true;
    }
    // A refresh (e.g. a reply arriving) waits while the reader is writing here.
    if (stale && !composing(section)) {
      stale = false;
      render();
    }
  };
  store.addEventListener("change", onChange);
  queueMicrotask(() => (section.dataset.mounted = "1"));
  render();
  return section;
}

/** The file's hunks as the reader wants them: with or without whitespace-only changes. */
export function activeHunks(file: FileEntry): Hunk[] {
  return showWhitespace() ? file.hunks : (file.hunksNoWs ?? file.hunks);
}

/**
 * Hunks inside the named functions: those overlapping a symbol's definition in
 * the new file, else those mentioning it. `byText` only checks mentions.
 */
export function hunksFor(file: FileEntry, hunks: Hunk[], symbols: string[], byText = false): Hunk[] {
  const hits = new Set<Hunk>();
  for (const symbol of symbols) {
    const spans = byText ? undefined : file.symbols?.[symbol.split("::").at(-1)!];
    const inside = spans?.length ? hunks.filter((h) => overlaps(h, spans)) : [];
    for (const h of inside.length ? inside : hunks.filter((h) => mentions(h, symbol))) hits.add(h);
  }
  return hunks.filter((h) => hits.has(h));
}

export function fileAnchor(branch: string, file: string): string {
  return `diff-${branch}-${file}`.replace(/[^A-Za-z0-9_-]+/g, "-");
}

/** Notes for one file from every <review-notes> block for `branch` on the page. */
export function notesFor(branch: string, file?: string): ReviewNote[] {
  const all: ReviewNote[] = [];
  for (const el of document.querySelectorAll<HTMLElement>(`review-notes[branch="${CSS.escape(branch)}"]`)) {
    all.push(...parseNotes(el));
  }
  return file === undefined ? all : all.filter((n) => n.file === file);
}

export function parseNotes(el: HTMLElement): ReviewNote[] {
  if (!noteCache.has(el)) {
    const script = el.querySelector('script[type="application/yaml"]');
    let notes: ReviewNote[] = [];
    try {
      notes = (script?.textContent ? YAML.parse(script.textContent) : []) ?? [];
    } catch (err) {
      console.error("review-notes: invalid YAML", err);
    }
    noteCache.set(el, notes);
  }
  return noteCache.get(el)!;
}

export function noteEl(n: ReviewNote): HTMLElement {
  const kind = meta.annotationKinds.find((k) => k.id === n.kind);
  const div = document.createElement("div");
  div.className = `card note note-${n.kind}`;
  div.style.setProperty("--note-color", kind?.color ?? "#6e7781");
  div.innerHTML = `<div class="card-head"><span class="note-kind">${escapeHtml(kind?.label ?? n.kind)}</span><span class="card-author">guide</span></div>
    <div class="card-body">${inlineMarkdown(n.text)}</div>`;
  return div;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

export function inlineMarkdown(s: string): string {
  return escapeHtml(String(s))
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

export function cleanContext(context: string): string {
  return context
    .replace(/\s*\{\s*$/, "")
    .replace(/^\s*(pub(\([^)]*\))?\s+)?(async\s+)?/, "")
    .trim();
}

// Helpers

/**
 * Where each line-comment thread sits in the diff shown: on its line if that
 * line still has the code it was written on, else on the line that now has
 * that code. Threads with neither are `loose` and shown above the diff.
 */
function anchorLineThreads(opts: FileDiffOptions, shownLines: DiffLine[]) {
  const anchorOf = new Map<string, DiffLine>();
  const loose: ReviewComment[][] = [];
  const lineThreads = threadsOf(
    comments().filter((c) => c.branch === opts.branch.name && c.file === opts.file.file && c.line),
  ).filter(threadVisible);
  for (const list of lineThreads) {
    const c = list[0];
    const onSide = (l: DiffLine) => (c.side === "old" ? l.kind === "del" : l.kind !== "del");
    const no = (l: DiffLine) => (c.side === "old" ? l.oldNo : l.newNo);
    const text = c.code?.split("\n").at(-1);
    const here = shownLines.find((l) => onSide(l) && no(l) === c.line && (text === undefined || l.text === text));
    const moved = here ?? (text?.trim() ? shownLines.find((l) => onSide(l) && l.text === text) : undefined);
    if (moved) anchorOf.set(threadKey(c), moved);
    else loose.push(list);
  }
  return { anchorOf, loose };
}

interface DiffLine {
  kind: "add" | "del" | "ctx";
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

const noteCache = new WeakMap<HTMLElement, ReviewNote[]>();

function overlaps(h: Hunk, spans: [number, number][]): boolean {
  const end = h.newStart + h.lines.filter((l) => l[0] !== "-").length;
  return spans.some(([a, b]) => h.newStart <= b && end >= a);
}

function mentions(h: Hunk, symbol: string): boolean {
  return h.context.includes(symbol) || h.lines.some((l) => l.includes(symbol));
}

/** A markdown file rendered like on GitHub: highlighted code. */
function markdownPreview(text: string): HTMLElement {
  const box = document.createElement("div");
  box.className = "md-preview markdown";
  box.innerHTML = marked.parse(text, { async: false }) as string;
  for (const code of box.querySelectorAll<HTMLElement>('pre code[class*="language-"]')) {
    const name = /language-(\S+)/.exec(code.className)?.[1] ?? "";
    const language = ({ sh: "bash", shell: "bash", console: "bash", yml: "yaml", py: "python", rs: "rust", ts: "typescript", js: "typescript" } as Record<string, string>)[name] ?? name;
    if (["bash", "json", "python", "rust", "sql", "typescript", "yaml"].includes(language)) {
      code.innerHTML = highlight(code.textContent ?? "", language);
      code.classList.add("hljs");
    }
  }
  return box;
}

function header(
  opts: FileDiffOptions,
  hunks: Hunk[],
  reviewed: boolean,
  collapsed: boolean,
  hash: string,
  setCollapsed: (c: boolean) => void,
): HTMLElement {
  const head = document.createElement("div");
  head.className = "file-head";
  const f = opts.file;
  const status = { A: "added", D: "deleted" }[f.status] ?? "";
  const lines = hunks.flatMap((h) => h.lines);
  const added = lines.filter((l) => l[0] === "+").length;
  const removed = lines.filter((l) => l[0] === "-").length;
  const fileThreads = threadsOf(comments().filter((c) => c.branch === opts.branch.name && c.file === f.file)).filter(threadVisible);
  const folded = fileThreads.length;
  const foldedReply = fileThreads.some((t) => t.at(-1)!.author);
  head.innerHTML = `
    <button type="button" class="collapse" title="Collapse">${collapsed ? "▸" : "▾"}</button>
    <code class="file-name">${escapeHtml(f.file)}</code>${opts.label ? ` <span class="file-label">${escapeHtml(opts.label)}</span>` : ""}
    ${status ? `<span class="tag">${status}</span>` : ""}
    ${collapsed && folded ? `<button type="button" class="folded-comments${foldedReply ? " reply" : ""}" title="${folded} comment thread${folded === 1 ? "" : "s"} in this folded file; click to open">💬${folded}</button>` : ""}
    <span class="added">+${added}</span><span class="removed">−${removed}</span>
    <span class="spacer"></span>
    <button type="button" class="file-comment" title="Comment on this file">💬</button>
    <label class="reviewed-box"><input type="checkbox" ${reviewed ? "checked" : ""}> Reviewed</label>`;
  head.querySelector(".collapse")!.addEventListener("click", () => setCollapsed(!collapsed));
  head.querySelector(".folded-comments")?.addEventListener("click", () => setCollapsed(false));
  head.querySelector(".file-comment")!.addEventListener("click", () => {
    const composer = composerEl((text) => addComment({ branch: opts.branch.name, file: f.file, text }), "", undefined, `new|${opts.branch.name}|${f.file}`);
    head.after(composer);
    composer.querySelector("textarea")!.focus();
  });
  head.querySelector<HTMLInputElement>(".reviewed-box input")!.addEventListener("change", (e) => {
    const on = (e.target as HTMLInputElement).checked;
    setCollapsed(on);
    setReviewed(opts.branch.name, f.file, hash, on);
  });
  return head;
}

function parseHunk(h: Hunk): DiffLine[] {
  let oldNo = h.oldStart;
  let newNo = h.newStart;
  const out: DiffLine[] = [];
  for (const line of h.lines) {
    const sign = line[0];
    const text = line.slice(1);
    if (sign === "+") out.push({ kind: "add", oldNo: null, newNo: newNo++, text });
    else if (sign === "-") out.push({ kind: "del", oldNo: oldNo++, newNo: null, text });
    else if (sign === " ") out.push({ kind: "ctx", oldNo: oldNo++, newNo: newNo++, text });
  }
  return out;
}

/** Map each anchorable note to the diff line it belongs after. */
function placeNotes(notes: ReviewNote[], hunks: DiffLine[][]): Map<ReviewNote, DiffLine> {
  const placed = new Map<ReviewNote, DiffLine>();
  const lines = hunks.flat();
  for (const n of notes) {
    const old = n.side === "old";
    let hit: DiffLine | undefined;
    if (n.line !== undefined) hit = lines.find((l) => (old ? l.oldNo : l.newNo) === n.line);
    else if (n.at) {
      const candidates = lines.filter((l) => l.text.includes(n.at!));
      hit = candidates.find((l) => (old ? l.kind === "del" : l.kind !== "del")) ?? candidates[0];
    }
    if (hit) placed.set(n, hit);
  }
  return placed;
}

function renderHunk(
  h: Hunk,
  lines: DiffLine[],
  mode: "unified" | "split",
  language: string | null,
  placed: Map<ReviewNote, DiffLine>,
  opts: FileDiffOptions,
  anchorOf: Map<string, DiffLine>,
): HTMLElement {
  const box = document.createElement("div");
  box.className = `hunk hunk-${mode}`;
  box.innerHTML = `<div class="hunk-head">@@ ${escapeHtml(cleanContext(h.context))}</div>`;
  const table = document.createElement("table");
  const branchComments = comments().filter((c) => c.branch === opts.branch.name && c.file === opts.file.file && c.line);
  const lineDraftKey = (l: DiffLine, side: "old" | "new") =>
    `new|${opts.branch.name}|${opts.file.file}|${side}|${side === "old" ? l.oldNo : l.newNo}`;
  /** A new thread on the line, or a reply in `thread` (its comments). */
  const comment = (l: DiffLine, side: "old" | "new", text: string, thread: ReviewComment[] = [], range: DiffLine[] = []) =>
    addComment(
      {
        branch: opts.branch.name,
        file: opts.file.file,
        line: (side === "old" ? l.oldNo : l.newNo) ?? undefined,
        startLine: range.length > 1 ? ((side === "old" ? range[0].oldNo : range[0].newNo) ?? undefined) : undefined,
        side,
        code: range.length > 1 ? range.map((r) => r.text).join("\n") : l.text,
        thread: thread[0]?.thread,
        text,
      },
      thread.length > 0,
    );
  // Click a line number (or +) to comment on that line; drag over several to comment on all of them.
  const rowsOf: Record<"old" | "new", { tr: HTMLTableRowElement; l: DiffLine; cell: HTMLElement }[]> = { old: [], new: [] };
  let drag: { side: "old" | "new"; from: number; to: number } | null = null;
  const paint = () => {
    for (const side of ["old", "new"] as const)
      rowsOf[side].forEach((r, i) => {
        const on = !!drag && drag.side === side && i >= Math.min(drag.from, drag.to) && i <= Math.max(drag.from, drag.to);
        r.cell.closest("td")?.parentElement?.classList.toggle(`range-${side}`, on);
      });
  };
  const beginDrag = (e: MouseEvent, l: DiffLine, side: "old" | "new") => {
    if (e.button !== 0) return;
    e.preventDefault();
    const i = rowsOf[side].findIndex((r) => r.l === l);
    drag = { side, from: i, to: i };
    paint();
    const move = (ev: MouseEvent) => {
      const target = (ev.target as HTMLElement).closest("tr");
      const j = rowsOf[side].findIndex((r) => r.tr === target);
      if (drag && j >= 0 && j !== drag.to) {
        drag.to = j;
        paint();
      }
    };
    const up = () => {
      document.removeEventListener("mouseover", move);
      document.removeEventListener("mouseup", up);
      if (!drag) return;
      const [a, b] = [Math.min(drag.from, drag.to), Math.max(drag.from, drag.to)];
      const picked = rowsOf[side].slice(a, b + 1);
      drag = null;
      paint();
      const last = picked.at(-1)!;
      startComment(last.cell, last.l, side, picked.map((r) => r.l));
    };
    document.addEventListener("mouseover", move);
    document.addEventListener("mouseup", up);
  };
  // Everything attached to a line (the guide's notes and your comments) forms one thread under it.
  const extras = (ls: DiffLine[]) => {
    const rows: HTMLTableRowElement[] = [];
    for (const l of ls) {
      const lineNotes = [...placed].filter(([, at]) => at === l).map(([n]) => n);
      const lineComments = branchComments.filter((c) => anchorOf.get(threadKey(c)) === l);
      const threads = threadsOf(lineComments).filter(threadVisible);
      if (!lineNotes.length && !threads.length) continue;
      const side = l.kind === "del" ? "old" : "new";
      const row = fullRow(document.createElement("div"), mode);
      const cell = row.querySelector("td")!;
      cell.replaceChildren();
      for (const [i, list] of (threads.length ? threads : [[]]).entries()) {
        const thread: HTMLElement = threadEl(i === 0 ? lineNotes : [], list, () =>
          openComposer(
            thread,
            (text) => comment(l, side, text, list),
            undefined,
            list.length ? replyDraftKey(threadKey(list[0])) : lineDraftKey(l, side),
          ),
        );
        cell.append(thread);
      }
      rows.push(row);
    }
    return rows;
  };
  const code = (l: DiffLine | null) => (l ? highlight(l.text, language) : "");
  const gutter = (l: DiffLine | null, side: "old" | "new") => {
    const td = document.createElement("td");
    td.className = "ln";
    const no = l ? (side === "old" ? l.oldNo : l.newNo) : null;
    if (no !== null && l) {
      td.textContent = String(no);
      td.title = "Comment on this line; drag to comment on several";
      td.addEventListener("mousedown", (e) => beginDrag(e, l, side));
    }
    return td;
  };
  /** Open a composer under the row, or in the line's existing thread. */
  const startComment = (cell: HTMLElement, l: DiffLine, side: "old" | "new", range: DiffLine[] = []) => {
    const row = cell.closest("tr")!;
    const next = row.nextElementSibling;
    const existing = next?.classList.contains("extra") ? next.querySelector<HTMLElement>("td") : null;
    const send = (text: string) => comment(l, side, text, [], range);
    if (existing) {
      openComposer(existing, send, undefined, lineDraftKey(l, side));
      return;
    }
    const holder = fullRow(document.createElement("div"), mode);
    const box = holder.querySelector("td")!;
    if (range.length > 1) {
      const first = side === "old" ? range[0].oldNo : range[0].newNo;
      const lastNo = side === "old" ? l.oldNo : l.newNo;
      const label = document.createElement("div");
      label.className = "range-label";
      label.textContent = `Lines ${first}–${lastNo}`;
      box.append(label);
    }
    row.after(holder);
    openComposer(box, send, () => holder.remove(), lineDraftKey(l, side));
  };
  const codeCell = (l: DiffLine | null, sign: string, side: "old" | "new") => {
    const td = document.createElement("td");
    td.className = `code ${l ? l.kind : "empty"}`;
    td.innerHTML = l ? `<span class="sign">${sign}</span>${code(l)}` : "";
    if (l) {
      const add = document.createElement("button");
      add.type = "button";
      add.className = "add-comment";
      add.title = "Comment on this line";
      add.textContent = "+";
      add.addEventListener("mousedown", (e) => beginDrag(e, l, side));
      td.prepend(add);
    }
    return td;
  };

  if (mode === "unified") {
    for (const l of lines) {
      const tr = document.createElement("tr");
      tr.className = l.kind;
      tr.append(gutter(l.kind === "add" ? null : l, "old"), gutter(l.kind === "del" ? null : l, "new"));
      const cell = codeCell(l, l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ", l.kind === "del" ? "old" : "new");
      tr.append(cell);
      rowsOf[l.kind === "del" ? "old" : "new"].push({ tr, l, cell });
      table.append(tr, ...extras([l]));
    }
  } else {
    for (const [left, right] of pairLines(lines)) {
      const tr = document.createElement("tr");
      const leftCell = codeCell(left, left?.kind === "del" ? "-" : " ", "old");
      const rightCell = codeCell(right, right?.kind === "add" ? "+" : " ", "new");
      tr.append(gutter(left, "old"), leftCell, gutter(right, "new"), rightCell);
      if (left) rowsOf.old.push({ tr, l: left, cell: leftCell });
      if (right) rowsOf.new.push({ tr, l: right, cell: rightCell });
      const sides = left === right ? [left] : [left, right];
      table.append(tr, ...extras(sides.filter((l): l is DiffLine => l !== null)));
    }
  }
  box.append(table);
  return box;
}

/** Split view rows: context on both sides; runs of deletions paired with the additions that follow. */
function pairLines(lines: DiffLine[]): [DiffLine | null, DiffLine | null][] {
  const rows: [DiffLine | null, DiffLine | null][] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].kind === "ctx") {
      rows.push([lines[i], lines[i]]);
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i].kind === "del") dels.push(lines[i++]);
    while (i < lines.length && lines[i].kind === "add") adds.push(lines[i++]);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push([dels[k] ?? null, adds[k] ?? null]);
  }
  return rows;
}

function fullRow(content: HTMLElement, mode: "unified" | "split"): HTMLTableRowElement {
  const tr = document.createElement("tr");
  tr.className = "extra";
  const td = document.createElement("td");
  td.colSpan = mode === "unified" ? 3 : 4;
  td.append(content);
  tr.append(td);
  return tr;
}

/** A GitHub-style thread: the guide's notes first, then your comments, and a reply box. */
/** Per-line highlighting: good enough for diffs, though multi-line strings/comments lose color. */
export function highlight(code: string, language: string | null): string {
  if (!language) return escapeHtml(code);
  return hljs.highlight(code, { language, ignoreIllegals: true }).value;
}

export function languageFor(file: string): string | null {
  const ext = file.split(".").at(-1) ?? "";
  const map: Record<string, string> = {
    rs: "rust",
    ts: "typescript",
    tsx: "typescript",
    js: "typescript",
    mjs: "typescript",
    py: "python",
    sql: "sql",
    yaml: "yaml",
    yml: "yaml",
    json: "json",
    sh: "bash",
  };
  return map[ext] ?? null;
}
