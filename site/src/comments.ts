// Comments on the live docs site. Every block of a page (paragraph, list item,
// table and table row, heading, diagram) gets a 💬 button in its left margin;
// a diagram's boxes get one too. Comments show as threads under their block:
// reply, edit, delete, resolve. A panel lists every thread on the site, and a
// rail on the right edge marks where this page's threads are.
//
// Comments are kept by the server that runs the site (src/node/comments.mjs):
// `site dev`, or `site serve` for a built site. So every device sees the same
// threads, and an agent replies from a shell (`in-ctrl comments reply`);
// replies arrive without a reload. A static host without that API shows
// nothing of this.
//
// A comment remembers its section, the block's position in it and the start
// of the block's text. When the page changes, it finds the block by that text,
// else by position (marked "outdated"), else sits under the section heading.

const BASE = import.meta.env.BASE_URL.endsWith("/") ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`;
const API = `${BASE}_in-ctrl/comments`;

interface Anchor {
  section: string;
  sectionTitle: string;
  /** "heading" for the section itself, else the block's position in the section (b0, b1, …). */
  block: string;
  quote: string;
  /** For diagrams: the box the comment is about. */
  about?: string;
}

interface Comment {
  id: string;
  page: string;
  /** The page's Markdown source, relative to the project (filled in by the server). */
  file?: string;
  anchor: Anchor;
  text: string;
  created: string;
  edited?: string;
  /** Who wrote a reply from a shell ("agent", or their --as); absent for the reader. */
  author?: string;
  /** The id of the thread's first comment. */
  thread: string;
}

interface State {
  comments: Record<string, Comment>;
  resolved: Record<string, true>;
}

type Op = { coll: keyof State; id: string; value: unknown };

let state: State = { comments: {}, resolved: {} };
const changes = new EventTarget();

void start();

async function start() {
  if (!(await load())) return;
  document.body.classList.add("ic-comments-on");
  installPage();
  installPanel();
  installRail();
  const events = new EventSource(`${API}/events`);
  events.onmessage = () => void refresh();
  window.addEventListener("focus", () => void refresh());
}

// The store

async function load(): Promise<boolean> {
  try {
    const res = await fetch(API, { cache: "no-store" });
    if (!res.ok || !res.headers.get("Content-Type")?.includes("json")) return false;
    state = normalize(await res.json());
    return true;
  } catch {
    return false;
  }
}

async function refresh() {
  try {
    const res = await fetch(API, { cache: "no-store" });
    if (!res.ok) return;
    const next = normalize(await res.json());
    if (JSON.stringify(next) === JSON.stringify(state)) return;
    state = next;
    changes.dispatchEvent(new Event("change"));
  } catch {
    // Offline for a moment; the next event or focus retries.
  }
}

function save(ops: Op[]) {
  for (const { coll, id, value } of ops) {
    const items = state[coll] as Record<string, unknown>;
    if (value === null) delete items[id];
    else items[id] = value;
  }
  changes.dispatchEvent(new Event("change"));
  fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(ops) })
    .then(async (res) => {
      if (!res.ok) throw new Error(String(res.status));
      state = normalize(await res.json());
      changes.dispatchEvent(new Event("change"));
    })
    .catch(() => alert("Couldn't save the comment: is the docs server still running?"));
}

function normalize(raw: Partial<State>): State {
  return { comments: raw?.comments ?? {}, resolved: raw?.resolved ?? {} };
}

function comments(): Comment[] {
  return Object.values(state.comments).sort((a, b) => a.created.localeCompare(b.created));
}

function threadKey(c: Comment): string {
  return `t|${c.thread ?? c.id}`;
}

function threadsOf(list: Comment[]): Comment[][] {
  const byKey = new Map<string, Comment[]>();
  for (const c of list) byKey.set(threadKey(c), [...(byKey.get(threadKey(c)) ?? []), c]);
  return [...byKey.values()];
}

const isResolved = (key: string) => !!state.resolved[key];
const setResolved = (key: string, on: boolean) => save([{ coll: "resolved", id: key, value: on ? true : null }]);

function addComment(page: string, anchor: Anchor, text: string, thread?: string) {
  const id = newId();
  save([{ coll: "comments", id, value: { id, page, anchor, text, created: new Date().toISOString(), thread: thread ?? id } }]);
}

function updateComment(c: Comment, text: string) {
  save([{ coll: "comments", id: c.id, value: { ...c, text, edited: new Date().toISOString() } }]);
}

function deleteComment(c: Comment) {
  save([{ coll: "comments", id: c.id, value: null }]);
}

/** crypto.randomUUID only exists in secure contexts (not plain http over a LAN). */
function newId(): string {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Whether resolved threads show on the pages (they always show in the panel). */
const showResolved = () => localStorage.getItem(PREFIX + "showResolved") === "1";
const PREFIX = "in-ctrl:";

// The page

interface Block {
  el: HTMLElement;
  section: string;
  sectionTitle: string;
  id: string;
  quote: string;
}

const CONTENT = ".sl-markdown-content";
/** Containers whose children are commented on one by one. */
const EXPAND = ":is(ul, ol, table > :is(thead, tbody, tfoot))";
const SKIP = ".ic-holder, .ic-holder-row, script, style";
const FIGURE = "figure.in-ctrl-figure";
/** A diagram box's label, by kind of box. */
const BOX_LABELS = [".cd-label", ".cd-decision-label", ".cd-entity-head", ".cd-group-label", ".cd-note-label", ".cd-seq-name"];
const BOX = ".react-flow__node, .cd-seq-card";

let page: PageComments | null = null;
/** A thread to show even if resolved: the one the panel jumped to. */
let revealed: string | null = null;

function currentPage(): string {
  const p = location.pathname.replace(/index\.html$/, "");
  return p.endsWith("/") ? p : `${p}/`;
}

function installPage() {
  const setup = () => {
    const content = document.querySelector<HTMLElement>(CONTENT);
    page = content ? new PageComments(content) : null;
  };
  setup();
  document.addEventListener("astro:page-load", setup);

  // One 💬 button, moved to the block under the pointer (the last tapped one
  // on touch screens).
  const button = floatingButton("ic-block-button", "Comment on this");
  let review: DiagramReview | null = null;
  let target: Block | null = null;
  const show = (e: MouseEvent | PointerEvent) => {
    if (review) { button.hidden = true; return; }
    if ((e.target as Element).closest?.(".ic-block-button")) return;
    let block = page?.blockAt(e.target as Element) ?? null;
    // Moving from a block to its button crosses the margin: keep the block
    // while the pointer stays level with it.
    if (!block && target && !(e instanceof PointerEvent && e.pointerType === "touch")) {
      const r = target.el.getBoundingClientRect();
      if (e.clientY >= r.top - 4 && e.clientY <= r.bottom + 4 && e.clientX < r.right) block = target;
    }
    if (block === target) return;
    target?.el.classList.remove("ic-target");
    target = block;
    button.hidden = !block;
    if (!block) return;
    block.el.classList.add("ic-target");
    const r = block.el.getBoundingClientRect();
    // In the left margin; where there is none (a phone), just above the block's right end,
    // so the button doesn't cover its first words.
    const roomy = r.left >= 34;
    button.style.top = `${r.top + window.scrollY - (roomy ? 0 : 28)}px`;
    button.style.left = `${roomy ? r.left + window.scrollX - 32 : r.right + window.scrollX - 26}px`;
  };
  document.addEventListener("mousemove", show);
  document.addEventListener("pointerdown", (e) => e.pointerType === "touch" && show(e));
  button.addEventListener("click", () => target && page?.startComment(target));

  // A second button on the diagram box under the pointer. Diagrams draw in
  // shadow roots: the box is found on the event's composed path.
  const boxButton = floatingButton("ic-block-button ic-box-button", "");
  let box: { block: Block; name: string; el: Element } | null = null;
  const showBox = (e: MouseEvent | PointerEvent) => {
    if ((e.target as Element).closest?.(".ic-box-button")) return;
    const node = e.composedPath().find((n): n is Element => n instanceof Element && n.matches(BOX));
    const figure = node ? (node.getRootNode() as ShadowRoot).host?.closest<HTMLElement>(FIGURE) : null;
    const block = figure ? page?.blockAt(figure) : null;
    const name = node ? boxName(node) : "";
    if (!node || !block || !name) {
      if (box && !nearBox(box.el, e)) (boxButton.hidden = true), (box = null);
      return;
    }
    box = { block, name, el: node };
    const r = node.getBoundingClientRect();
    boxButton.title = `Comment on ${name}`;
    const size = matchMedia("(pointer: coarse)").matches ? 44 : 26;
    boxButton.style.position = review ? "fixed" : "absolute";
    boxButton.style.top = `${review ? Math.max(60, Math.min(innerHeight - size, r.top - 12)) : r.top + window.scrollY - 12}px`;
    boxButton.style.left = `${review ? Math.max(0, Math.min(innerWidth - size, r.right - 14)) : r.right + window.scrollX - 14}px`;
    boxButton.hidden = false;
  };
  document.addEventListener("mousemove", showBox);
  document.addEventListener("pointerdown", (e) => e.pointerType === "touch" && showBox(e));
  document.addEventListener("pointermove", (e) => { if (e.pointerType === "touch") boxButton.hidden = true; });
  boxButton.addEventListener("click", () => {
    if (!box) return;
    if (review) review.comment(box.name);
    else page?.startComment(box.block, box.name);
  });

  // Light-DOM controls are slotted into the native dialog: they stay in its
  // active/focusable tree and retain the site's comment styles and listeners.
  const viewChanged = (host: HTMLElement, expanded: boolean) => {
    review?.dispose();
    review = null;
    box = null;
    boxButton.hidden = true;
    boxButton.removeAttribute("slot");
    document.body.append(boxButton);
    const block = page?.blockAt(host.closest(FIGURE));
    if (expanded && page && block) {
      review = new DiagramReview(host, page, block);
      boxButton.slot = "diagram-comment-overlay";
      host.append(boxButton);
      button.hidden = true;
    }
  };
  document.addEventListener("in-ctrl:diagram-view", (e) => {
    const host = e.composedPath().find((n): n is HTMLElement => n instanceof HTMLElement && n.matches(".in-ctrl-diagram"));
    if (host) viewChanged(host, (e as CustomEvent<{ expanded: boolean }>).detail.expanded);
  });
  // Opening a diagram before the comments API answers must also work.
  for (const host of document.querySelectorAll<HTMLElement>(".in-ctrl-diagram")) {
    if (host.shadowRoot?.querySelector("dialog[open]")) viewChanged(host, true);
  }
}

class DiagramReview {
  private tools = document.createElement("button");
  private panel = document.createElement("section");
  private release: (() => void) | null = null;

  constructor(host: HTMLElement, private owner: PageComments, private block: Block) {
    this.tools.type = "button";
    this.tools.className = "ic-diagram-comment-button";
    this.tools.slot = "diagram-comment-tools";
    this.tools.textContent = "Comment";
    this.tools.setAttribute("aria-expanded", "false");
    this.tools.addEventListener("click", () => this.release ? this.close() : this.comment());
    this.panel.className = "ic-diagram-review";
    this.panel.slot = "diagram-comment-overlay";
    this.panel.setAttribute("role", "region");
    this.panel.setAttribute("aria-label", "Diagram comments");
    this.panel.hidden = true;
    this.panel.innerHTML = '<header class="ic-review-heading"><strong>Diagram comments</strong><button type="button" aria-label="Close diagram comments">Close</button></header>';
    this.panel.querySelector("button")!.addEventListener("click", () => this.close());
    this.panel.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      // Keep the draft and dismiss comments before dismissing the diagram.
      e.preventDefault();
      e.stopPropagation();
      this.close();
    }, true);
    host.append(this.tools, this.panel);
  }

  comment(about?: string) {
    if (!this.release) {
      this.panel.hidden = false;
      this.release = this.owner.mountReview(this.block, this.panel);
      this.tools.setAttribute("aria-expanded", "true");
    }
    const existing = this.panel.querySelector<HTMLTextAreaElement>(".ic-composer textarea");
    if (about === undefined && existing) existing.focus();
    else this.owner.startComment(this.block, about ?? "");
  }

  private close() {
    this.release?.();
    this.release = null;
    this.panel.hidden = true;
    this.tools.setAttribute("aria-expanded", "false");
    this.tools.focus({ preventScroll: true });
  }

  dispose() {
    this.release?.();
    this.tools.remove();
    this.panel.remove();
  }
}

class PageComments {
  private blocks: Block[];
  private path = currentPage();
  private review: { block: Block; holder: HTMLElement } | null = null;

  constructor(readonly content: HTMLElement) {
    this.blocks = collectBlocks(content);
    let stale = false;
    const onChange = () => {
      if (!this.content.isConnected) return changes.removeEventListener("change", onChange);
      stale = true;
      // A refresh (a reply arriving) waits while the reader is writing.
      if (stale && !composing(document)) {
        stale = false;
        this.render();
      }
    };
    changes.addEventListener("change", onChange);
    changes.addEventListener("composer", onChange);
    const jump = location.hash.match(/^#comment-(.+)$/)?.[1];
    if (jump) revealed = `t|${decodeURIComponent(jump)}`;
    this.render();
    for (const b of this.blocks) if (draft(this.draftKey(b))) this.startComment(b, "", false);
    if (jump) requestAnimationFrame(() => this.jumpTo(revealed!));
  }

  /** The block containing `el`: the innermost one, so a table row wins over its table. */
  blockAt(el: Element | null): Block | null {
    for (let node = el; node && node !== this.content.parentElement; node = node.parentElement) {
      if (node.closest(".ic-holder")) return null;
      const block = this.blocks.find((b) => b.el === node);
      if (block) return block;
    }
    return null;
  }

  jumpTo(key: string) {
    const el = document.querySelector<HTMLElement>(`.ic-thread[data-thread="${CSS.escape(key)}"]`);
    if (el) flash(el);
  }

  /**
   * Put each visible thread under its block. Threads that didn't change stay
   * as they are (with a reply being written in them); only new, changed and
   * removed ones are touched.
   */
  render() {
    const shown = new Map<string, HTMLElement>();
    for (const el of document.querySelectorAll<HTMLElement>(".ic-holder > .ic-thread[data-thread]")) shown.set(el.dataset.thread!, el);
    const wanted = new Set<string>();
    for (const list of threadsOf(comments().filter((c) => c.page === this.path))) {
      const key = threadKey(list[0]);
      if (isResolved(key) && !showResolved() && key !== revealed) continue;
      wanted.add(key);
      const sig = JSON.stringify([isResolved(key), list.map((c) => [c.id, c.text, c.edited ?? ""])]);
      const current = shown.get(key);
      if (current?.dataset.sig === sig || (current && composing(current))) continue;
      const anchor = list[0].anchor;
      const { block, outdated } = this.locate(anchor);
      if (!block) continue;
      const thread = threadEl(list, () => openComposer(thread, (text) => addComment(this.path, anchor, text, list[0].thread), `reply|${key}`));
      thread.dataset.sig = sig;
      if (outdated) {
        const note = document.createElement("div");
        note.className = "ic-outdated";
        note.textContent = `Outdated: the text this was on has changed. It was: “${anchor.quote}”`;
        thread.prepend(note);
      }
      if (current) current.replaceWith(thread);
      else this.holderAfter(block).append(thread);
    }
    for (const [key, el] of shown) {
      if (wanted.has(key) || composing(el)) continue;
      const holder = el.parentElement!;
      el.remove();
      if (!holder.querySelector(".ic-thread, .ic-composer")) dropHolder(holder);
    }
  }

  /** The block a comment belongs to, found by its text, else its position, else its section's heading. */
  private locate(anchor: Anchor): { block: Block | undefined; outdated: boolean } {
    const inSection = this.blocks.filter((b) => b.section === anchor.section);
    const heading = inSection.find((b) => b.id === "heading") ?? this.blocks[0];
    if (anchor.block === "heading") return { block: heading, outdated: !inSection.length };
    const quote = anchor.quote.slice(0, 60);
    const byText = inSection.find((b) => b.id !== "heading" && b.quote.startsWith(quote));
    if (byText) return { block: byText, outdated: false };
    return { block: inSection.find((b) => b.id === anchor.block) ?? heading, outdated: true };
  }

  startComment(b: Block, about = "", focus = true) {
    const holder = this.holderAfter(b);
    holder.querySelector(":scope > .ic-composer")?.remove();
    let chosen = about;
    const key = this.draftKey(b);
    const composer = composerEl(
      (text) => addComment(this.path, anchorOf(b, chosen), text),
      "",
      () => (holder.querySelector(".ic-thread") ? composer.remove() : dropHolder(holder)),
      key,
    );
    const names = b.el.matches(FIGURE) ? boxNames(b.el) : [];
    if (names.length) {
      const pick = document.createElement("label");
      pick.className = "ic-about";
      pick.innerHTML = `About <select><option value="">the whole diagram</option>${names
        .map((n) => `<option${n === about ? " selected" : ""}>${escapeHtml(n)}</option>`)
        .join("")}</select>`;
      pick.querySelector("select")!.addEventListener("change", (e) => (chosen = (e.target as HTMLSelectElement).value));
      composer.prepend(pick);
    }
    holder.append(composer);
    if (focus) composer.querySelector("textarea")!.focus();
  }

  /** Move, rather than clone, threads/composers; drafts and listeners survive. */
  mountReview(b: Block, container: HTMLElement): () => void {
    const holder = this.holderAfter(b);
    const marker = document.createComment("diagram comment position");
    holder.before(marker);
    this.review = { block: b, holder };
    container.append(holder);
    return () => {
      this.review = null;
      if (marker.isConnected) marker.replaceWith(holder);
      else holder.remove();
    };
  }

  private draftKey(b: Block): string {
    return `new|${this.path}|${b.section}|${b.id}`;
  }

  /** The box right after a block where its threads go. */
  private holderAfter(b: Block): HTMLElement {
    if (this.review?.block === b) return this.review.holder;
    // A table row's threads go in a full-width row after it.
    if (b.el.localName === "tr") {
      const next = b.el.nextElementSibling;
      if (next?.matches(".ic-holder-row")) return next.querySelector<HTMLElement>(".ic-holder")!;
      const row = document.createElement("tr");
      row.className = "ic-holder-row";
      row.innerHTML = `<td colspan="${b.el.children.length}"><div class="ic-holder"></div></td>`;
      b.el.after(row);
      return row.querySelector<HTMLElement>(".ic-holder")!;
    }
    // A list item can't take a <div> sibling; its threads go inside it.
    const inside = b.el.localName === "li";
    const existing = inside
      ? b.el.querySelector<HTMLElement>(":scope > .ic-holder")
      : b.el.nextElementSibling?.matches(".ic-holder")
        ? (b.el.nextElementSibling as HTMLElement)
        : null;
    if (existing) return existing;
    const holder = document.createElement("div");
    holder.className = "ic-holder";
    if (inside) b.el.append(holder);
    else b.el.after(holder);
    return holder;
  }
}

function collectBlocks(content: HTMLElement): Block[] {
  const blocks: Block[] = [];
  const title = document.querySelector<HTMLElement>("main h1");
  let section = "top";
  let sectionTitle = title?.textContent?.trim() || document.title;
  let index = 0;
  if (title) blocks.push({ el: title, section, sectionTitle, id: "heading", quote: sectionTitle });
  const walk = (container: Element) => {
    for (const el of [...container.children] as HTMLElement[]) {
      if (el.matches(SKIP)) continue;
      if (el.matches(EXPAND)) {
        walk(el);
        continue;
      }
      const h2 = el.matches("h2") ? el : el.matches(".sl-heading-wrapper.level-h2") ? el.querySelector("h2") : null;
      if (h2) {
        sectionTitle = h2.textContent?.trim() ?? "";
        section = h2.id || slug(sectionTitle);
        index = 0;
        blocks.push({ el, section, sectionTitle, id: "heading", quote: sectionTitle });
        continue;
      }
      blocks.push({ el, section, sectionTitle, id: `b${index++}`, quote: quoteOf(el) });
      // A table is a block, and so is each of its rows (the row wins under the pointer).
      if (el.localName === "table") walk(el);
      // Code blocks: each line is also a block (the line wins under the pointer).
      if (el.matches(".expressive-code, figure.frame, pre") || el.querySelector(".ec-line")) {
        for (const line of el.querySelectorAll<HTMLElement>(".ec-line")) {
          blocks.push({ el: line, section, sectionTitle, id: `b${index++}`, quote: quoteOf(line) });
        }
      }
    }
  };
  walk(content);
  return blocks;
}

function anchorOf(b: Block, about: string): Anchor {
  return { section: b.section, sectionTitle: b.sectionTitle, block: b.id, quote: b.quote, ...(about ? { about } : {}) };
}

/** The start of a block's text; a diagram uses its caption, or its source. */
function quoteOf(el: HTMLElement): string {
  if (el.matches(FIGURE)) {
    const caption = el.querySelector("figcaption")?.textContent?.trim();
    return `Diagram: ${caption || el.querySelector<HTMLElement>(".in-ctrl-diagram")?.dataset.file || ""}`;
  }
  const copy = el.cloneNode(true) as HTMLElement;
  copy.querySelectorAll(".ic-holder, .sr-only").forEach((n) => n.remove());
  const text = (copy.textContent ?? "").replace(/\s+/g, " ").trim();
  // A line of code: its file (or line number) first, "app.yaml:3: port: 8080".
  if (el.matches(".ec-line")) {
    const code = el.closest("code");
    const line = code ? [...code.querySelectorAll(".ec-line")].indexOf(el) + 1 : 0;
    const file = el.closest(".expressive-code")?.querySelector(".header .title")?.textContent?.trim();
    return `${file ? `${file}:${line}: ` : line ? `L${line}: ` : ""}${text}`.slice(0, 120);
  }
  return text.slice(0, 120);
}

function boxName(node: Element): string {
  for (const label of BOX_LABELS) {
    const lines = [...node.querySelectorAll(label)].map((l) => l.textContent?.trim() ?? "").filter(Boolean);
    if (lines.length) return lines.join(" ");
  }
  return "";
}

/** The names of a diagram's boxes, from inside its shadow root. */
function boxNames(figure: HTMLElement): string[] {
  const root = figure.querySelector(".in-ctrl-diagram")?.shadowRoot;
  if (!root) return [];
  return [...new Set([...root.querySelectorAll(BOX)].map(boxName).filter(Boolean))];
}

function nearBox(el: Element, e: MouseEvent): boolean {
  const r = el.getBoundingClientRect();
  return e.clientX >= r.left - 4 && e.clientX <= r.right + 20 && e.clientY >= r.top - 20 && e.clientY <= r.bottom + 4;
}

function dropHolder(holder: HTMLElement) {
  (holder.closest<HTMLElement>(".ic-holder-row") ?? holder).remove();
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// Threads and composers

function threadEl(list: Comment[], onReply: () => void): HTMLElement {
  const thread = document.createElement("div");
  thread.className = "ic-thread";
  const key = threadKey(list[0]);
  thread.dataset.thread = key;
  const resolved = isResolved(key);
  thread.classList.toggle("ic-resolved", resolved);
  // A reply left unfinished (before a reload) opens again with its text.
  if (draft(`reply|${key}`)) queueMicrotask(onReply);
  for (const c of list) thread.append(commentEl(c));
  const actions = document.createElement("div");
  actions.className = "ic-actions";
  actions.innerHTML = `${resolved ? `<span class="ic-resolved-tag">✓ Resolved</span>` : ""}<button type="button" class="ic-reply">Reply…</button><button type="button" class="ic-resolve">${resolved ? "Reopen" : "Resolve"}</button>`;
  actions.querySelector(".ic-reply")!.addEventListener("click", onReply);
  actions.querySelector(".ic-resolve")!.addEventListener("click", () => setResolved(key, !resolved));
  thread.append(actions);
  return thread;
}

function commentEl(c: Comment): HTMLElement {
  const div = document.createElement("div");
  div.className = `ic-comment${c.author ? " ic-from-author" : ""}`;
  const when = new Date(c.edited ?? c.created).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  const author = c.author ? c.author[0].toUpperCase() + c.author.slice(1) : "You";
  const about = c.anchor.about ? `<span class="ic-about-tag">about ${escapeHtml(c.anchor.about)}</span>` : "";
  div.innerHTML = `<div class="ic-head"><span class="ic-author">${escapeHtml(author)}</span>${about}<span class="ic-when">${escapeHtml(when)}${c.edited ? " (edited)" : ""}</span>
    <span class="ic-tools">${c.author ? "" : `<button type="button" class="ic-edit">Edit</button>`}<button type="button" class="ic-delete">Delete</button></span></div>
    <div class="ic-body">${inlineMarkdown(c.text)}</div>`;
  div.querySelector(".ic-delete")!.addEventListener("click", () => confirm("Delete this comment?") && deleteComment(c));
  div.querySelector(".ic-edit")?.addEventListener("click", () => {
    const composer = composerEl((text) => updateComment(c, text), c.text, () => composer.replaceWith(div));
    div.replaceWith(composer);
    composer.querySelector("textarea")!.focus();
  });
  return div;
}

/** A composer at the end of a thread, before its actions. */
function openComposer(thread: HTMLElement, onSave: (text: string) => void, draftKey: string) {
  thread.querySelector(".ic-composer")?.remove();
  const composer = composerEl(onSave, "", undefined, draftKey);
  thread.querySelector(".ic-actions")!.before(composer);
  composer.querySelector("textarea")!.focus();
}

/** Whether the reader is writing under `root`: re-rendering it would throw the text away. */
function composing(root: ParentNode): boolean {
  return [...root.querySelectorAll<HTMLTextAreaElement>(".ic-composer textarea")].some(
    (area) => area.value.trim() !== "" || area === document.activeElement,
  );
}

/**
 * A comment box. With `draftKey`, what's typed is kept in this browser as it's
 * typed and comes back when the same box opens again (after a reload, too).
 */
function composerEl(onSave: (text: string) => void, initial = "", onCancel?: () => void, draftKey?: string): HTMLElement {
  const div = document.createElement("div");
  div.className = "ic-composer";
  div.innerHTML = `<textarea rows="3" placeholder="Comment (Ctrl+Enter to save)"></textarea>
    <div class="ic-composer-actions"><button type="button" class="ic-save">Save</button><button type="button" class="ic-cancel">Cancel</button></div>`;
  const area = div.querySelector("textarea")!;
  area.value = (draftKey && draft(draftKey)) || initial;
  if (draftKey) area.addEventListener("input", () => setDraft(draftKey, area.value));
  const close = () => {
    if (draftKey) setDraft(draftKey, "");
    if (onCancel) onCancel();
    else div.remove();
    // Views that held back a refresh while this was open catch up now.
    changes.dispatchEvent(new Event("composer"));
  };
  const saveIt = () => {
    const text = area.value.trim();
    area.value = "";
    if (text) onSave(text);
    close();
  };
  div.querySelector(".ic-save")!.addEventListener("click", saveIt);
  div.querySelector(".ic-cancel")!.addEventListener("click", close);
  area.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) saveIt();
    if (e.key === "Escape") close();
  });
  return div;
}

function draft(key: string): string {
  return localStorage.getItem(`${PREFIX}draft:${key}`) ?? "";
}

function setDraft(key: string, text: string) {
  if (text.trim()) localStorage.setItem(`${PREFIX}draft:${key}`, text);
  else localStorage.removeItem(`${PREFIX}draft:${key}`);
}

// The panel: every thread on the site

function installPanel() {
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "ic-panel-toggle";
  toggle.title = "Comments on these docs";
  const panel = document.createElement("aside");
  panel.className = "ic-panel";
  panel.hidden = true;
  document.body.append(toggle, panel);
  toggle.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    draw();
  });

  let lastHtml = "";
  const draw = () => {
    const open = threadsOf(comments()).filter((t) => !isResolved(threadKey(t[0])));
    toggle.textContent = `💬 ${open.length}`;
    toggle.classList.toggle("ic-has-replies", open.some((t) => t.at(-1)!.author));
    if (panel.hidden) return void (lastHtml = "");
    const all = threadsOf(comments());
    const byPage = new Map<string, Comment[][]>();
    for (const t of all) byPage.set(t[0].page, [...(byPage.get(t[0].page) ?? []), t]);
    const items = [...byPage]
      .map(([path, threads]) => {
        const title = threads[0][0].file ?? path;
        const rows = threads
          .map((t) => {
            const key = threadKey(t[0]);
            const last = t.at(-1)!;
            const where = `${t[0].anchor.sectionTitle}${t[0].anchor.about ? ` › ${t[0].anchor.about}` : ""}`;
            return `<li class="${isResolved(key) ? "ic-resolved" : ""}${last.author ? " ic-from-author" : ""}"><a href="${escapeHtml(path)}#comment-${encodeURIComponent(t[0].thread ?? t[0].id)}">
              <span class="ic-where">${escapeHtml(where)}${isResolved(key) ? " · resolved" : ""}</span>
              <span class="ic-text">${escapeHtml(t[0].text.slice(0, 140))}</span>
              ${t.length > 1 ? `<span class="ic-last">${escapeHtml(last.author ? last.author : "You")}: ${escapeHtml(last.text.slice(0, 100))}</span>` : ""}</a></li>`;
          })
          .join("");
        return `<section><h3><a href="${escapeHtml(path)}">${escapeHtml(title)}</a></h3><ul>${rows}</ul></section>`;
      })
      .join("");
    const html = `<header><strong>Comments</strong><button type="button" class="ic-close" title="Close">✕</button></header>
      <div class="ic-panel-tools"><label><input type="checkbox" class="ic-show-resolved"${showResolved() ? " checked" : ""}> Show resolved on pages</label>
      <button type="button" class="ic-copy" title="Open threads as Markdown, to paste to an agent or an issue">Copy as Markdown</button></div>
      ${items || `<p class="ic-empty">No comments yet. Point at a paragraph and press 💬.</p>`}
      <p class="ic-hint">Agents read and answer these with <code>in-ctrl comments</code>.</p>`;
    // Unchanged: keep the elements, so a click or a tick in progress isn't lost.
    if (html === lastHtml) return;
    lastHtml = html;
    panel.innerHTML = html;
    panel.querySelector(".ic-close")!.addEventListener("click", () => ((panel.hidden = true), draw()));
    panel.querySelector<HTMLInputElement>(".ic-show-resolved")!.addEventListener("change", (e) => {
      localStorage.setItem(PREFIX + "showResolved", (e.target as HTMLInputElement).checked ? "1" : "0");
      changes.dispatchEvent(new Event("change"));
    });
    panel.querySelector(".ic-copy")!.addEventListener("click", async (e) => {
      await navigator.clipboard?.writeText(markdown(open));
      (e.target as HTMLButtonElement).textContent = "Copied";
    });
    // A thread on this page opens in place.
    panel.querySelectorAll<HTMLAnchorElement>("li a").forEach((a) =>
      a.addEventListener("click", (e) => {
        const url = new URL(a.href);
        if (url.pathname !== currentPage()) return;
        e.preventDefault();
        revealed = `t|${decodeURIComponent(url.hash.slice("#comment-".length))}`;
        page?.render();
        page?.jumpTo(revealed);
      }),
    );
  };
  changes.addEventListener("change", draw);
  draw();
}

function markdown(threads: Comment[][]): string {
  const byPage = new Map<string, string[]>();
  for (const t of threads) {
    const first = t[0];
    const target = first.file ?? first.page;
    const a = first.anchor;
    const quote = a.block !== "heading" ? `\n  > ${a.quote}` : "";
    const body = t.map((c) => `  - ${c.author ?? "reader"}: ${c.text.replace(/\n/g, "\n    ")}`).join("\n");
    byPage.set(target, [...(byPage.get(target) ?? []), `- "${a.sectionTitle}"${a.about ? `, about ${a.about}` : ""}${quote}\n${body}`]);
  }
  return [...byPage].map(([target, items]) => `## ${target}\n\n${items.join("\n")}`).join("\n\n") + "\n";
}

// The rail: where this page's threads are, and jumps between them

function installRail() {
  const rail = document.createElement("div");
  rail.className = "ic-rail";
  const nav = document.createElement("div");
  nav.className = "ic-jump";
  nav.innerHTML = `<button type="button" title="Previous comment">▲ <span></span></button><button type="button" title="Next comment">▼ <span></span></button>`;
  document.body.append(rail, nav);
  const targets = () => [...document.querySelectorAll<HTMLElement>(".ic-thread")].filter((el) => el.offsetParent !== null);
  const pageY = (el: HTMLElement) => el.getBoundingClientRect().top + window.scrollY;
  let frame = 0;
  const draw = () => {
    frame = 0;
    const list = targets();
    rail.hidden = nav.hidden = !list.length;
    if (!list.length) return;
    const height = document.documentElement.scrollHeight;
    rail.replaceChildren(
      ...list.map((el) => {
        const last = [...el.querySelectorAll<HTMLElement>(".ic-comment")].at(-1);
        const mark = document.createElement("button");
        mark.type = "button";
        mark.className = `ic-mark${last?.classList.contains("ic-from-author") ? " ic-from-author" : ""}`;
        mark.style.top = `${(pageY(el) / height) * 100}%`;
        mark.title = (last?.querySelector(".ic-body")?.textContent ?? "").slice(0, 80);
        mark.addEventListener("click", () => flash(el));
        return mark;
      }),
    );
    const top = window.scrollY + 80;
    const bottom = window.scrollY + window.innerHeight - 80;
    const above = list.filter((el) => pageY(el) + el.offsetHeight < top);
    const below = list.filter((el) => pageY(el) > bottom);
    const [up, down] = nav.querySelectorAll<HTMLButtonElement>("button");
    up.querySelector("span")!.textContent = String(above.length);
    down.querySelector("span")!.textContent = String(below.length);
    up.disabled = !above.length;
    down.disabled = !below.length;
    up.onclick = () => above.at(-1) && flash(above.at(-1)!);
    down.onclick = () => below[0] && flash(below[0]);
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(draw);
  };
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule);
  document.addEventListener("astro:page-load", schedule);
  new MutationObserver((records) => {
    if (records.some((r) => !rail.contains(r.target) && !nav.contains(r.target))) schedule();
  }).observe(document.body, { childList: true, subtree: true });
  schedule();
}

// Helpers

function floatingButton(className: string, title: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.title = title;
  button.textContent = "💬";
  button.hidden = true;
  document.body.append(button);
  return button;
}

function flash(el: HTMLElement) {
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.classList.add("ic-flash");
  setTimeout(() => el.classList.remove("ic-flash"), 1500);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** `code`, **bold**, *emphasis*, [links](url) and line breaks. */
function inlineMarkdown(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|\/[^)\s]*)\)/g, '<a href="$2">$1</a>')
    .replace(/\n/g, "<br>");
}
