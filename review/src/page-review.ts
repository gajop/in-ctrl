// Reviewing the pages themselves, on every page (review and living docs):
//   - each section heading (h2) gets "Looks good" / "Needs work" marks and a
//     comment button;
//   - every block (paragraph, list item, table and table row, diagram, TL;DR, …) gets a 💬 button
//     in its left margin, and its comments show as a thread under it.
// A comment remembers its section, the block's position in it and the start of
// the block's text. When the page changes, it finds the block by that text,
// else by position (marked "outdated"), else sits under the section heading.

import { pages } from "./data";
import { escapeHtml } from "./diff";
import {
  type PageAnchor,
  type ReviewComment,
  type SectionMark,
  addComment,
  comments,
  isResolved,
  sectionMark,
  setSectionMark,
  store,
  threadKey,
  threadsOf,
} from "./store";
import { composerEl, composing, draft, openComposer, replyDraftKey, threadEl, threadVisible } from "./thread";

export function installPageReview() {
  const setup = () => {
    const main = document.querySelector("main");
    current = null;
    if (!main) return;
    // Repo markdown renders asynchronously; its blocks must exist before they're collected.
    const pending = () => [...main.querySelectorAll<HTMLElement>("repo-markdown")].some((md) => !md.dataset.done);
    if (!pending()) return void (current = new PageReview(main));
    const onRendered = () => {
      if (pending()) return;
      main.removeEventListener("markdown:rendered", onRendered);
      current = new PageReview(main);
    };
    main.addEventListener("markdown:rendered", onRendered);
  };
  document.addEventListener("guide:page", setup);
  setup();

  // One 💬 button, moved to the block under the pointer (or the last tapped
  // one on touch screens). Blocks like diagrams re-render themselves, so
  // nothing is added inside them.
  const button = document.createElement("button");
  button.type = "button";
  button.className = "block-comment";
  button.title = "Comment on this";
  button.textContent = "💬";
  button.hidden = true;
  document.body.append(button);
  let target: Block | null = null;
  const show = (e: MouseEvent | PointerEvent) => {
    if ((e.target as Element).closest?.(".block-comment")) return;
    let block = current?.blockAt(e.target as Element) ?? null;
    // Moving from a block to its button crosses the margin: keep the block
    // while the pointer stays level with it.
    if (!block && target && !(e instanceof PointerEvent && e.pointerType === "touch")) {
      const rect = target.el.getBoundingClientRect();
      if (e.clientY >= rect.top - 4 && e.clientY <= rect.bottom + 4 && e.clientX < rect.right) block = target;
    }
    if (block === target) return;
    target?.el.classList.remove("comment-target");
    target = block;
    button.hidden = !block;
    if (!block) return;
    block.el.classList.add("comment-target");
    const rect = block.el.getBoundingClientRect();
    const pre = block.el.closest("pre");
    button.style.top = `${rect.top + window.scrollY}px`;
    button.style.left = `${Math.max(2, (pre ? pre.getBoundingClientRect().left : rect.left) + window.scrollX - 30)}px`;
  };
  document.addEventListener("mousemove", show);
  document.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "touch") show(e);
  });
  button.addEventListener("click", () => target && current?.startComment(target));

  // A second button on the diagram box (graph node or sequence participant)
  // under the pointer: comments about that box.
  const boxButton = document.createElement("button");
  boxButton.type = "button";
  boxButton.className = "block-comment box-comment";
  boxButton.textContent = "💬";
  boxButton.hidden = true;
  document.body.append(boxButton);
  let box: { block: Block; name: string; el: Element } | null = null;
  document.addEventListener("mousemove", (e) => {
    const el = e.target as Element;
    if (el.closest?.(".box-comment")) return;
    const node = el.closest?.(`:is(${DIAGRAMS}) :is(.node, .participant)`);
    const block = node ? current?.blockAt(node) : null;
    const name = node?.querySelector(":scope > .name")?.textContent?.trim();
    if (!node || !block || !name) {
      // Keep it while the pointer is still near the box it belongs to.
      if (box && !nearBox(box.el, e)) (boxButton.hidden = true), (box = null);
      return;
    }
    if (box?.el === node) return;
    box = { block, name, el: node };
    const rect = node.getBoundingClientRect();
    boxButton.title = `Comment on ${name}`;
    boxButton.style.top = `${rect.top + window.scrollY - 12}px`;
    boxButton.style.left = `${rect.right + window.scrollX - 14}px`;
    boxButton.hidden = false;
  });
  boxButton.addEventListener("click", () => box && current?.commentOnBox(box.block, box.name, box.el));
}

function nearBox(el: Element, e: MouseEvent): boolean {
  const r = el.getBoundingClientRect();
  return e.clientX >= r.left - 4 && e.clientX <= r.right + 20 && e.clientY >= r.top - 20 && e.clientY <= r.bottom + 4;
}

// Helpers

interface Block {
  el: HTMLElement;
  section: string;
  sectionTitle: string;
  /** "heading", or b0, b1, … within the section. */
  id: string;
  quote: string;
}

// Containers whose children are commented on one by one (each bullet, each
// paragraph of the TL;DR, each part of an impact card).
const EXPAND = ".impact-grid, .impact-grid > div, repo-markdown, .tldr, main ul, main ol, main table > :is(thead, tbody, tfoot)";
const SKIP = "review-header, review-notes, review-code, script, style, .page-thread, h1";
const DIAGRAMS = "sys-graph, seq-flow";
let current: PageReview | null = null;

class PageReview {
  private blocks: Block[];
  private page = window.location.pathname;
  private branch = document.querySelector("review-header")?.getAttribute("branch") ?? undefined;

  constructor(private main: HTMLElement) {
    this.blocks = collectBlocks(main, pages.find((p) => p.path === this.page)?.title ?? document.title);
    for (const b of this.blocks.filter((x) => x.id === "heading")) {
      const tools = document.createElement("span");
      tools.className = "section-tools";
      b.el.append(tools);
    }
    let stale = false;
    const onChange = (e: Event) => {
      if (!this.main.isConnected) return store.removeEventListener("change", onChange);
      const key = (e as CustomEvent<string>).detail;
      if (key === "comments" || key === "resolved" || key === "showResolved") stale = true;
      // A refresh (e.g. a reply arriving) waits while the reader is writing a comment.
      if (stale && !composing(this.main)) {
        stale = false;
        this.renderThreads();
      }
      if (key === "marks") this.renderMarks();
    };
    store.addEventListener("change", onChange);
    // Diagrams draw after the page is set up (and again on Before/After).
    main.addEventListener("diagram:rendered", () => this.markBoxes());
    this.renderThreads();
    this.renderMarks();
    for (const b of this.blocks) if (draft(this.draftKey(b))) this.startComment(b, "", false);
  }

  /** The block containing `el`: the innermost one, so a grid cell wins over its grid. */
  blockAt(el: Element | null): Block | null {
    for (let node = el; node && node !== this.main; node = node.parentElement) {
      if (node.closest(".page-thread, .section-tools")) return null;
      const block = this.blocks.find((b) => b.el === node && b.id !== "heading");
      if (block) return block;
    }
    return null;
  }

  private renderMarks() {
    for (const b of this.blocks.filter((x) => x.id === "heading")) {
      const tools = b.el.querySelector<HTMLElement>(".section-tools")!;
      const key = `${this.page}#${b.section}`;
      const mark = sectionMark(key);
      const button = (value: SectionMark, label: string) =>
        `<button type="button" class="mark mark-${value}${mark === value ? " on" : ""}" data-mark="${value}" title="${mark === value ? "Clear" : label}">${label}</button>`;
      tools.innerHTML = `${button("good", "✓ Looks good")}${button("needs-work", "✗ Needs work")}<button type="button" class="mark-comment" title="Comment on this section">💬</button>`;
      tools.classList.toggle("marked", !!mark);
      tools.querySelectorAll<HTMLButtonElement>("[data-mark]").forEach((el) =>
        el.addEventListener("click", () => {
          const value = el.dataset.mark as SectionMark;
          setSectionMark(key, mark === value ? null : value);
        }),
      );
      tools.querySelector(".mark-comment")!.addEventListener("click", () => this.startComment(b));
    }
  }

  /** Outline the diagram boxes that have comments. */
  /**
   * Boxes with comments get an outline and a count badge; the badge opens
   * those comments next to the box (they live in a popover, not under the
   * diagram).
   */
  private markBoxes() {
    const counts = new Map<string, number>();
    for (const list of threadsOf(comments().filter((c) => c.page === this.page && c.anchor?.about)).filter(threadVisible)) {
      const key = `${list[0].anchor!.section}|${list[0].anchor!.about}`;
      counts.set(key, (counts.get(key) ?? 0) + list.length);
    }
    for (const b of this.blocks.filter((x) => x.el.matches(DIAGRAMS))) {
      for (const node of b.el.querySelectorAll<SVGGElement>(":is(.node, .participant)")) {
        const name = node.querySelector(":scope > .name")?.textContent?.trim() ?? "";
        const count = counts.get(`${b.section}|${name}`) ?? 0;
        node.classList.toggle("has-comments", count > 0);
        node.querySelector(":scope > .comment-badge")?.remove();
        const rect = node.querySelector<SVGRectElement>(":scope > rect");
        if (!count || !rect) continue;
        const x = Number(rect.getAttribute("x")) + Number(rect.getAttribute("width"));
        const y = Number(rect.getAttribute("y"));
        const badge = document.createElementNS("http://www.w3.org/2000/svg", "g");
        badge.setAttribute("class", "comment-badge");
        badge.innerHTML = `<circle cx="${x - 2}" cy="${y + 2}" r="8"></circle><text x="${x - 2}" y="${y + 5.5}" text-anchor="middle">${count}</text><title>${count} comment${count === 1 ? "" : "s"}</title>`;
        badge.addEventListener("click", (e) => {
          e.stopPropagation();
          this.toggleBoxComments(b, name, node);
        });
        node.append(badge);
      }
    }
  }

  /** A new comment about one diagram box, written in the box's popover. */
  commentOnBox(b: Block, name: string, node: Element) {
    const holder = this.boxHolder(b, name);
    if (!holder.classList.contains("open")) this.toggleBoxComments(b, name, node);
    holder.querySelector(":scope > .composer")?.remove();
    const draftKey = `${this.draftKey(b)}|${name}`;
    let saved = false;
    const composer = composerEl(
      (text) => {
        saved = true;
        this.save(anchorOf(b, name), text);
      },
      "",
      () => {
        composer.remove();
        // Cancelling a first comment leaves nothing to show; a saved one lands here.
        if (!saved && !holder.querySelector(".thread")) dropHolder(holder);
      },
      draftKey,
    );
    holder.append(composer);
    composer.querySelector("textarea")!.focus();
  }

  /** Show or hide the comments about one diagram box, next to it. */
  private toggleBoxComments(b: Block, name: string, node: Element) {
    const holder = this.boxHolder(b, name);
    const open = !holder.classList.contains("open");
    this.main.querySelectorAll(".box-popover.open").forEach((p) => p.classList.remove("open"));
    if (!open) return;
    const r = node.getBoundingClientRect();
    holder.style.top = `${r.top + window.scrollY}px`;
    holder.style.left = `${Math.min(r.right + 10, window.innerWidth - 440) + window.scrollX}px`;
    holder.classList.add("open");
  }

  /** The popover that holds the threads about box `name` of diagram `b`. */
  private boxHolder(b: Block, name: string): HTMLElement {
    const key = `${b.section}|${name}`;
    let holder = [...this.main.querySelectorAll<HTMLElement>(".box-popover")].find((p) => p.dataset.box === key);
    if (!holder) {
      holder = document.createElement("div");
      holder.className = "page-thread box-popover";
      holder.dataset.box = key;
      holder.innerHTML = `<div class="box-popover-head"><strong>${escapeHtml(name)}</strong><button type="button" class="close" title="Close">✕</button></div>`;
      holder.querySelector(".close")!.addEventListener("click", () => holder!.classList.remove("open"));
      b.el.after(holder);
    }
    return holder;
  }

  /**
   * Put each visible thread under its block. Threads that didn't change stay
   * as they are (with any reply being written in them); only new, changed
   * and removed ones are touched.
   */
  private renderThreads() {
    this.markBoxes();
    const shown = new Map<string, HTMLElement>();
    for (const el of this.main.querySelectorAll<HTMLElement>(".page-thread > .thread[data-thread]")) shown.set(el.dataset.thread!, el);
    const mine = comments().filter((c) => c.page === this.page && c.anchor);
    const wanted = new Set<string>();
    for (const list of threadsOf(mine).filter(threadVisible)) {
      const key = threadKey(list[0]);
      const sig = signature(list);
      wanted.add(key);
      const current = shown.get(key);
      if (current?.dataset.sig === sig || (current && composing(current))) continue;
      const anchor = list[0].anchor!;
      const { block, outdated } = this.locate(anchor);
      if (!block) continue;
      const thread: HTMLElement = threadEl([], list, () =>
        openComposer(thread, (text) => this.save(anchor, text, list), undefined, replyDraftKey(key)),
      );
      thread.dataset.sig = sig;
      if (outdated) {
        const note = document.createElement("div");
        note.className = "outdated";
        note.textContent = `Outdated: the text this was on has changed. It was: “${anchor.quote}”`;
        thread.prepend(note);
      }
      if (current) current.replaceWith(thread);
      else if (anchor.about && block.el.matches(DIAGRAMS)) this.boxHolder(block, anchor.about).append(thread);
      else this.holderAfter(block).append(thread);
    }
    for (const [key, el] of shown) {
      if (wanted.has(key) || composing(el)) continue;
      const holder = el.parentElement!;
      el.remove();
      if (!holder.querySelector(".thread")) dropHolder(holder);
    }
  }

  /** The block a comment belongs to, found by its text, else its position, else its section's heading. */
  private locate(anchor: PageAnchor): { block: Block | undefined; outdated: boolean } {
    const inSection = this.blocks.filter((b) => b.section === anchor.section);
    if (anchor.block === "heading") {
      const heading = inSection.find((b) => b.id === "heading") ?? this.blocks[0];
      return { block: heading, outdated: !inSection.length };
    }
    const quote = anchor.quote.slice(0, 60);
    const byText = inSection.find((b) => b.id !== "heading" && b.quote.startsWith(quote));
    if (byText) return { block: byText, outdated: false };
    const byPosition = inSection.find((b) => b.id === anchor.block);
    return { block: byPosition ?? inSection.find((b) => b.id === "heading") ?? this.blocks[0], outdated: true };
  }

  startComment(b: Block, preset = "", focus = true) {
    const holder = this.holderAfter(b);
    const diagram = b.el.matches(DIAGRAMS) ? boxNames(b.el) : [];
    let about = preset;
    holder.querySelector(":scope > .composer")?.remove();
    const composer = composerEl(
      (text) => this.save(anchorOf(b, about), text),
      "",
      () => (holder.childElementCount > 1 ? composer.remove() : dropHolder(holder)),
      this.draftKey(b),
    );
    if (diagram.length) {
      const pick = document.createElement("label");
      pick.className = "composer-about";
      pick.innerHTML = `About <select><option value="">the whole diagram</option>${diagram
        .map((n) => `<option${n === preset ? " selected" : ""}>${escapeHtml(n)}</option>`)
        .join("")}</select>`;
      pick.querySelector("select")!.addEventListener("change", (e) => (about = (e.target as HTMLSelectElement).value));
      composer.prepend(pick);
    }
    holder.append(composer);
    if (focus) composer.querySelector("textarea")!.focus();
  }

  /** Where an unfinished new comment on `b` is kept (see composerEl). */
  private draftKey(b: Block): string {
    return `new|${this.page}|${b.section}|${b.id}`;
  }

  /** A new thread, or a reply in `replyTo` (the thread's comments). */
  private save(anchor: PageAnchor, text: string, replyTo?: ReviewComment[]) {
    addComment({ page: this.page, branch: this.branch, anchor, text, thread: replyTo?.[0]?.thread }, !!replyTo);
  }

  /** The box right after a block where its threads go (inside grid cells, which can't take siblings). */
  private holderAfter(b: Block): HTMLElement {
    // A table row's threads go in a full-width row after it.
    if (b.el.localName === "tr") {
      const next = b.el.nextElementSibling;
      if (next?.matches(".page-thread-row")) return next.querySelector<HTMLElement>(".page-thread")!;
      const row = document.createElement("tr");
      row.className = "page-thread-row";
      row.innerHTML = `<td colspan="${b.el.children.length}"><div class="page-thread"></div></td>`;
      b.el.after(row);
      return row.querySelector<HTMLElement>(".page-thread")!;
    }
    // A code line's threads go right below the line within pre/code.
    if (b.el.matches(".code-line, .ec-line")) {
      const next = b.el.nextElementSibling;
      if (next?.matches(".page-thread")) return next as HTMLElement;
      const holder = document.createElement("div");
      holder.className = "page-thread code-thread";
      b.el.after(holder);
      return holder;
    }
    // List items and grid cells can't take a <div> sibling; the thread goes inside them.
    const inCell = b.el.matches("li") || !!b.el.parentElement?.matches(".impact-grid");
    const existing = inCell
      ? b.el.querySelector<HTMLElement>(":scope > .page-thread")
      : b.el.nextElementSibling?.matches(".page-thread")
        ? (b.el.nextElementSibling as HTMLElement)
        : null;
    if (existing) return existing;
    const holder = document.createElement("div");
    holder.className = "page-thread";
    if (inCell) b.el.append(holder);
    else b.el.after(holder);
    return holder;
  }
}

/** Remove an empty thread holder (with the table row wrapping it, for a row's threads). */
function dropHolder(holder: HTMLElement) {
  (holder.closest<HTMLElement>(".page-thread-row") ?? holder).remove();
}

/** Changes whenever a thread's comments or resolved state change. */
function signature(list: ReviewComment[]): string {
  return JSON.stringify([isResolved(threadKey(list[0])), list.map((c) => [c.id, c.text, c.edited ?? ""])]);
}

function collectBlocks(main: HTMLElement, pageTitle: string): Block[] {
  const blocks: Block[] = [];
  let section = "top";
  let sectionTitle = pageTitle;
  let index = 0;
  const title = main.querySelector("h1");
  if (title) blocks.push({ el: title, section, sectionTitle, id: "heading", quote: pageTitle });
  const walk = (container: Element) => {
    for (const el of [...container.children] as HTMLElement[]) {
      if (el.matches(SKIP) || el.matches(".page-thread-row")) continue;
      if (el.matches(EXPAND)) {
        walk(el);
        continue;
      }
      if (el.localName === "h2") {
        sectionTitle = el.textContent?.trim() ?? "";
        section = el.id || slug(sectionTitle);
        index = 0;
        blocks.push({ el, section, sectionTitle, id: "heading", quote: sectionTitle });
        continue;
      }
      blocks.push({ el, section, sectionTitle, id: `b${index++}`, quote: quoteOf(el) });
      // A table is a block, and so is each of its rows (the row wins under the pointer).
      if (el.localName === "table" && !el.closest(SKIP)) walk(el);
      // Code blocks: each line is also a block (the line wins under the pointer).
      if ((el.localName === "pre" || el.querySelector(".code-line, .ec-line")) && !el.closest(SKIP)) {
        const lines = el.querySelectorAll<HTMLElement>(".code-line, .ec-line");
        for (const line of lines) {
          blocks.push({ el: line, section, sectionTitle, id: `b${index++}`, quote: quoteOf(line) });
        }
      }
    }
  };
  walk(main);
  return blocks;
}

function anchorOf(b: Block, about: string): PageAnchor {
  return { section: b.section, sectionTitle: b.sectionTitle, block: b.id, quote: b.quote, ...(about ? { about } : {}) };
}

/** The start of a block's text; diagrams use their caption or source instead of their labels. */
function quoteOf(el: HTMLElement): string {
  if (el.matches(DIAGRAMS)) {
    const source = el.getAttribute("caption") ?? el.getAttribute("flow") ?? el.getAttribute("view") ?? el.getAttribute("elements");
    return `${el.localName === "sys-graph" ? "Diagram" : "Sequence"}: ${source ?? el.querySelector(".caption")?.textContent ?? ""}`.trim();
  }
  if (el.matches(".code-line, .ec-line")) {
    const lineNum = el.dataset.line ?? (el.parentElement ? [...el.parentElement.querySelectorAll(".code-line, .ec-line")].indexOf(el) + 1 : 0);
    const pre = el.closest("pre");
    const fileHint = pre?.getAttribute("data-file");
    const copy = el.cloneNode(true) as HTMLElement;
    copy.querySelectorAll(".page-thread, .block-comment").forEach((n) => n.remove());
    const lineText = (copy.textContent ?? "").replace(/\s+/g, " ").trim();
    const prefix = fileHint ? `${fileHint}:${lineNum}: ` : lineNum ? `L${lineNum}: ` : "";
    return `${prefix}${lineText}`.slice(0, 120);
  }
  return (el.textContent ?? "").replace(/💬/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
}

/** The names of a diagram's boxes (graph nodes or sequence participants). */
function boxNames(el: HTMLElement): string[] {
  const names = [...el.querySelectorAll(".node:not(.group) .name, .participant .name")].map((n) => n.textContent?.trim() ?? "");
  return [...new Set(names.filter(Boolean))];
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
