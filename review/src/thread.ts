// GitHub-style threads, used under diff lines (diff.ts) and under page blocks
// (page-review.ts): the guide's notes, then the comments (the reader's and an
// agent's replies), a reply box, and Resolve. Resolved threads leave the page
// (they stay in the review panel) unless the reader chooses to show them.

import { settings } from "./settings";
import { escapeHtml, inlineMarkdown, noteEl, type ReviewNote } from "./diff";
import {
  type ReviewComment,
  deleteComments,
  isResolved,
  setResolved,
  showResolved,
  store,
  threadKey,
  updateComment,
} from "./store";

/** Whether a thread shows on the page: open, or resolved while the reader shows those (or jumped to it). */
export function threadVisible(mine: ReviewComment[]): boolean {
  if (!mine.length) return true;
  const key = threadKey(mine[0]);
  return !isResolved(key) || showResolved() || key === revealed;
}

/** Show this thread even if resolved (the review panel jumps to it). */
export function reveal(key: string) {
  if (revealed === key) return;
  revealed = key;
  store.dispatchEvent(new CustomEvent("change", { detail: "showResolved" }));
}

/** The draft key for a reply in the thread `key`: pass it to openComposer from `onReply`. */
export function replyDraftKey(key: string | null): string | undefined {
  return key ? `reply|${key}` : undefined;
}

export function draft(key: string): string {
  return localStorage.getItem(DRAFT_PREFIX + key) ?? "";
}

function setDraft(key: string, text: string) {
  if (text.trim()) localStorage.setItem(DRAFT_PREFIX + key, text);
  else localStorage.removeItem(DRAFT_PREFIX + key);
}

export function threadEl(notes: ReviewNote[], mine: ReviewComment[], onReply: () => void): HTMLElement {
  const thread = document.createElement("div");
  thread.className = "thread";
  const key = mine.length ? threadKey(mine[0]) : null;
  if (key) thread.dataset.thread = key;
  // A reply left unfinished (e.g. before a reload) opens again with its text.
  const pending = replyDraftKey(key);
  if (pending && draft(pending)) queueMicrotask(onReply);
  const resolved = !!key && isResolved(key);
  thread.classList.toggle("resolved", resolved);
  notes.forEach((n) => thread.append(noteEl(n)));
  mine.forEach((c) => thread.append(commentEl(c)));
  const actions = document.createElement("div");
  actions.className = "thread-actions";
  if (resolved) actions.innerHTML = `<span class="resolved-tag">✓ Resolved</span>`;
  const reply = document.createElement("button");
  reply.type = "button";
  reply.className = "thread-reply";
  reply.textContent = "Reply…";
  reply.addEventListener("click", onReply);
  actions.append(reply);
  if (key) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "thread-resolve";
    toggle.textContent = resolved ? "Reopen" : "Resolve";
    toggle.addEventListener("click", () => setResolved(key, !resolved));
    actions.append(toggle);
  }
  thread.append(actions);
  return thread;
}

/** Insert a composer at the end of `host` (before its reply button, if any). */
export function openComposer(host: HTMLElement, onSave: (text: string) => void, onCancel?: () => void, draftKey?: string) {
  host.querySelector(".composer")?.remove();
  const composer = composerEl(onSave, "", onCancel, draftKey);
  const actions = host.querySelector(".thread-actions");
  if (actions) actions.before(composer);
  else host.append(composer);
  composer.querySelector("textarea")!.focus();
}

/** Whether the reader is writing in a composer under `root`: re-rendering it would throw the text away. */
export function composing(root: ParentNode): boolean {
  return [...root.querySelectorAll<HTMLTextAreaElement>(".composer textarea")].some(
    (area) => area.value.trim() !== "" || area === document.activeElement,
  );
}

/**
 * A comment box. With `draftKey`, what's typed is kept in this browser as it's
 * typed and comes back when the same box opens again (after a reload, too);
 * Save or Cancel drops it.
 */
export function composerEl(onSave: (text: string) => void, initial = "", onCancel?: () => void, draftKey?: string): HTMLElement {
  const div = document.createElement("div");
  div.className = "composer";
  div.innerHTML = `<textarea rows="3" placeholder="Comment (Ctrl+Enter to save)"></textarea>
    <div class="composer-actions"><button type="button" class="save">Save</button><button type="button" class="cancel">Cancel</button></div>`;
  const area = div.querySelector("textarea")!;
  area.value = (draftKey && draft(draftKey)) || initial;
  if (draftKey) area.addEventListener("input", () => setDraft(draftKey, area.value));
  const close = () => {
    if (draftKey) setDraft(draftKey, "");
    if (onCancel) onCancel();
    else div.remove();
    // Views that held back a refresh while this was open catch up now.
    store.dispatchEvent(new CustomEvent("change", { detail: "composer" }));
  };
  const save = () => {
    if (area.value.trim()) onSave(area.value.trim());
    close();
  };
  div.querySelector(".save")!.addEventListener("click", save);
  div.querySelector(".cancel")!.addEventListener("click", close);
  area.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) save();
    if (e.key === "Escape") close();
  });
  return div;
}

// Helpers

let revealed: string | null = null;
const DRAFT_PREFIX = `${settings.storageKey}:draft:`;

function commentEl(c: ReviewComment): HTMLElement {
  const div = document.createElement("div");
  div.className = `card comment${c.author ? " from-agent" : ""}`;
  div.dataset.commentId = c.id;
  const when = new Date(c.edited ?? c.created).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  const author = c.author ? c.author[0].toUpperCase() + c.author.slice(1) : "You";
  const about = c.anchor?.about ? `<span class="card-about">about ${escapeHtml(c.anchor.about)}</span>` : "";
  div.innerHTML = `<div class="card-head"><span class="card-author">${escapeHtml(author)}</span>${about}<span class="card-when">${escapeHtml(when)}${c.edited ? " (edited)" : ""}</span>
    <span class="card-actions">${c.author ? "" : `<button type="button" class="edit">Edit</button>`}<button type="button" class="delete">Delete</button></span></div>
    <div class="card-body">${inlineMarkdown(c.text)}</div>`;
  div.querySelector(".delete")!.addEventListener("click", () => deleteComments(new Set([c.id])));
  div.querySelector(".edit")?.addEventListener("click", () => {
    const composer = composerEl((text) => updateComment(c.id, text), c.text, () => composer.replaceWith(div));
    div.replaceWith(composer);
    composer.querySelector("textarea")!.focus();
  });
  return div;
}
