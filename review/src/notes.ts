// <review-notes branch="…">: the page author's annotations on the branch's code
// (YAML list in an inline script, see diff.ts). They render only inline, as
// threads in the diffs; the code bar picks which show (none, important, all).
//
// installCommentsPanel(): a floating button with the reader's comments across
// all branches — copy as Markdown, delete, or add a general comment.

import { settings } from "./settings";
import { pages } from "./data";
import { escapeHtml, fileAnchor, inlineMarkdown, notesFor } from "./diff";
import {
  type ReviewComment,
  VERDICTS,
  type Verdict,
  branchReview,
  comments,
  commentPlace,
  commentsMarkdown,
  deleteComments,
  isResolved,
  threadKey,
  type NoteLevel,
  noteLevel,
  reviewedBranches,
  setBranchReview,
  setShowResolved,
  showResolved,
  store,
} from "./store";
import { inFlight, inboxHtml, lastSent, sendToAi } from "./live";
import { reviewLocation } from "./sync";
import { reveal } from "./thread";

/** Holds the page's notes (read by the diffs); shows nothing itself. */
export class ReviewNotes extends HTMLElement {
  connectedCallback() {
    this.hidden = true;
  }
}

/** "Notes: None | Important | Detail" for the code bar, with how many notes each level shows. */
export function noteLevelControl(branch: string): string {
  const notes = notesFor(branch);
  if (!notes.length) return "";
  const important = notes.filter((n) => n.kind === "important").length;
  const levels: [NoteLevel, string, string][] = [
    ["none", "None", "Hide the page author's notes"],
    ["important", `Important ${important}`, "Only notes that need your attention"],
    ["detail", `Detail ${notes.length}`, "Every note, important ones included"],
  ];
  const current = noteLevel();
  return `<span class="note-level" title="The page author's notes on the code">Notes <span class="segmented">${levels
    .map(([value, label, title]) => `<button type="button" data-note-level="${value}" class="${value === current ? "active" : ""}" title="${escapeHtml(title)}">${label}</button>`)
    .join("")}</span></span>`;
}

export function installCommentsPanel() {
  if (document.querySelector(".comments-fab")) return;
  const fab = document.createElement("button");
  fab.type = "button";
  fab.className = "comments-fab";
  fab.title = "Your review";
  // Talking to the AI is its own button: the review (verdict, comments) is one thing, sending it another.
  const aiFab = document.createElement("button");
  aiFab.type = "button";
  aiFab.className = "comments-fab ai-fab";
  aiFab.title = "Send your review to the AI";
  const panel = document.createElement("div");
  panel.className = "comments-panel";
  panel.hidden = true;
  let mode: "review" | "ai" = "review";
  document.body.append(aiFab, fab, panel);

  const wireClose = () => panel.querySelector(".close")!.addEventListener("click", () => ((panel.hidden = true), render()));
  /** The send box: note, Send button, the inbox. Lives in the AI panel. */
  const wireSend = () => {
    wireClose();
    const all = comments();
    const since = lastSent();
    const isNew = (when?: string) => !since || (!!when && when > since);
    const busy = inFlight();
    const nothingNew =
      !all.filter((c) => !c.author && !isResolved(threadKey(c)) && isNew(c.edited ?? c.created)).length &&
      !reviewedBranches().filter((b) => isNew(branchReview(b).updated)).length &&
      !sendNote.trim();
    const note = panel.querySelector<HTMLTextAreaElement>(".send-note")!;
    note.addEventListener("input", () => {
      sendNote = note.value;
      // A note alone is worth sending, unless a request is still open.
      const send = panel.querySelector<HTMLButtonElement>(".send")!;
      if (!busy && nothingNew) {
        send.disabled = !sendNote.trim();
        send.textContent = sendNote.trim() ? "Send to AI (note)" : "Nothing new to send";
      }
    });
    note.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) panel.querySelector<HTMLButtonElement>(".send")!.click();
    });
    panel.querySelector<HTMLButtonElement>(".send")!.addEventListener("click", async (e) => {
      const button = e.target as HTMLButtonElement;
      button.disabled = true;
      try {
        await sendToAi(sendNote);
        sendNote = "";
        render();
      } catch {
        button.disabled = false;
        alert("Couldn't send: the server has no inbox (a static copy of the review?).");
      }
    });
  };
  const currentBranch = () => document.querySelector("review-header")?.getAttribute("branch") ?? null;
  const pageTitle = () => pages.find((p) => p.path === window.location.pathname)?.title ?? "this page";
  const render = () => {
    const all = comments();
    fab.textContent = `💬 ${all.length}`;
    fab.classList.toggle("empty", all.length === 0);
    {
      const since0 = lastSent();
      const fresh = (when?: string) => !since0 || (!!when && when > since0);
      const pending = all.filter((c) => !c.author && !isResolved(threadKey(c)) && fresh(c.edited ?? c.created)).length +
        reviewedBranches().filter((b) => fresh(branchReview(b).updated)).length;
      const working = inFlight();
      // A dot, not a second count: 💬 already counts the comments.
      aiFab.textContent = working ? "🤖 …" : pending ? "🤖 •" : "🤖";
      aiFab.title = working ? "The AI is working on your last send" : pending ? `${pending} change${pending === 1 ? "" : "s"} not sent to the AI yet` : "Send your review to the AI";
      aiFab.classList.toggle("has-new", !!pending && !working);
    }
    fab.classList.toggle("active", !panel.hidden && mode === "review");
    aiFab.classList.toggle("active", !panel.hidden && mode === "ai");
    if (panel.hidden) return;
    const branch = currentBranch();
    const here = branch ? all.filter((c) => c.branch === branch) : all.filter((c) => c.page === window.location.pathname);
    const review = branch ? branchReview(branch) : null;
    const withReviews = reviewedBranches();
    const open = all.filter((c) => !isResolved(threadKey(c)));
    // What the AI hasn't been sent yet: the reader's open comments and verdicts changed since the last Send.
    const since = lastSent();
    const isNew = (when?: string) => !since || (!!when && when > since);
    const unsent = open.filter((c) => !c.author && isNew(c.edited ?? c.created));
    const unsentReviews = withReviews.filter((b) => isNew(branchReview(b).updated));
    const busy = inFlight();
    const nothingNew = !unsent.length && !unsentReviews.length && !sendNote.trim();
    const sendLabel = busy
      ? busy.status === "working" ? "The AI is working on it…" : "Sent, waiting for the AI…"
      : nothingNew ? "Nothing new to send" : `Send to AI (${[unsent.length && `${unsent.length} new comment${unsent.length > 1 ? "s" : ""}`, unsentReviews.length && `${unsentReviews.length} verdict${unsentReviews.length > 1 ? "s" : ""}`].filter(Boolean).join(", ") || "note"})`;
    const resolved = all.filter((c) => isResolved(threadKey(c)));
    const sendBox = `<div class="send-box">
        <textarea class="send-note" rows="2" placeholder="Note for the AI (optional): what to focus on. Ctrl+Enter sends.">${escapeHtml(sendNote)}</textarea>
        <button type="button" class="send" ${busy || nothingNew ? "disabled" : ""}>${escapeHtml(sendLabel)}</button>
        <span class="muted">The AI reads your open comments and verdicts, fixes things, replies in the threads, and publishes a new version. Comments marked <span class="sent-tag new">new</span> haven't been sent yet.</span>
        <ul class="panel-list inbox">${inboxHtml()}</ul>
      </div>`;
    if (mode === "ai") {
      panel.innerHTML = `<div class="panel-head"><strong>Send to AI</strong><button type="button" class="close">✕</button></div>${sendBox}`;
      wireSend();
      return;
    }
    panel.innerHTML = `
      <div class="panel-head"><strong>Your review</strong><span class="muted">${reviewLocation()}</span><button type="button" class="close">✕</button></div>
      ${
        branch && review
          ? `<div class="review-form">
        <div class="verdicts">${(Object.keys(VERDICTS) as Verdict[])
          .map((v) => `<label class="verdict verdict-${v}"><input type="radio" name="verdict" value="${v}" ${review.verdict === v ? "checked" : ""}> ${VERDICTS[v]}</label>`)
          .join("")}</div>
        <div class="muted verdict-help">Approve means "merge into ${escapeHtml(settings.baseBranch)}". Branches merge in order, so an approval waits for the branches it is built on.</div>
        <textarea class="summary" rows="3" placeholder="Summary for ${escapeHtml(branch)}">${escapeHtml(review.summary)}</textarea>
      </div>`
          : ""
      }
      <div class="panel-row">
        <button type="button" class="copy-branch" ${here.length || branch ? "" : "disabled"}>Copy ${branch ? "this branch's review" : `comments on ${escapeHtml(pageTitle())}`}</button>
        <button type="button" class="copy-all" ${all.length || withReviews.length ? "" : "disabled"}>Copy all</button>
        <button type="button" class="del-branch danger" ${here.length ? "" : "disabled"}>Delete ${branch ? "this branch's" : "this page's"} comments</button>
        <button type="button" class="del-all danger" ${all.length ? "" : "disabled"}>Delete all comments</button>
      </div>
      <div class="panel-tabs">
        <button type="button" data-tab="open" class="${tab === "open" ? "active" : ""}">Open ${open.length}</button>
        <button type="button" data-tab="resolved" class="${tab === "resolved" ? "active" : ""}">Resolved ${resolved.length}</button>
        <span class="spacer"></span>
        ${tab === "resolved" ? `<label class="show-resolved"><input type="checkbox" ${showResolved() ? "checked" : ""}> Show on pages</label>
        <button type="button" class="del-resolved danger" ${resolved.length ? "" : "disabled"}>Delete resolved</button>` : ""}
      </div>
      <ul class="panel-list comments-list">${
        (tab === "open" ? repliesFirst(open) : resolved).map((c) => listItem(c, tab === "open" && unsent.includes(c))).join("") ||
        `<li class="muted">${tab === "open" ? "No open comments. Hover any paragraph, diagram box or section title and press 💬; in code, hover a line and press +." : "Nothing resolved yet."}</li>`
      }</ul>`;
    panel.querySelectorAll<HTMLInputElement>('input[name="verdict"]').forEach((input) =>
      input.addEventListener("change", () => {
        setBranchReview(branch!, { ...branchReview(branch!), verdict: input.value as Verdict });
        // A verdict is the end of reviewing this page.
        panel.hidden = true;
        render();
      }),
    );
    panel.querySelector<HTMLTextAreaElement>(".summary")?.addEventListener("change", (e) =>
      setBranchReview(branch!, { ...branchReview(branch!), summary: (e.target as HTMLTextAreaElement).value }),
    );
    wireClose();
    panel.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((b) =>
      b.addEventListener("click", () => ((tab = b.dataset.tab as "open" | "resolved"), render())),
    );
    panel.querySelector<HTMLInputElement>(".show-resolved input")?.addEventListener("change", (e) =>
      setShowResolved((e.target as HTMLInputElement).checked),
    );
    panel.querySelector(".del-resolved")?.addEventListener("click", () => {
      if (confirm(`Delete ${resolved.length} resolved comments? This can't be undone.`)) {
        deleteComments(new Set(resolved.map((c) => c.id)));
      }
    });
    panel.querySelectorAll<HTMLElement>(".comments-list li[data-id]").forEach((li) =>
      li.addEventListener("click", (e) => {
        if ((e.target as Element).closest(".item-delete")) return;
        const c = all.find((x) => x.id === li.dataset.id);
        if (!c) return;
        panel.hidden = true;
        goTo(c);
      }),
    );
    panel.querySelector(".copy-all")?.addEventListener("click", (e) =>
      copy(commentsMarkdown(all, withReviews), e.target as HTMLElement),
    );
    panel.querySelector(".copy-branch")?.addEventListener("click", (e) =>
      copy(commentsMarkdown(here, branch ? [branch] : []), e.target as HTMLElement),
    );
    panel.querySelector(".del-all")?.addEventListener("click", () => {
      if (confirm(`Delete all ${all.length} comments?`)) deleteComments(new Set(all.map((c) => c.id)));
    });
    panel.querySelector(".del-branch")?.addEventListener("click", () => {
      if (confirm(`Delete ${here.length} comments on ${branch ?? pageTitle()}?`)) deleteComments(new Set(here.map((c) => c.id)));
    });
    panel.querySelectorAll<HTMLButtonElement>(".item-delete").forEach((b) =>
      b.addEventListener("click", () => deleteComments(new Set([b.dataset.id!]))),
    );
  };
  const toggle = (m: "review" | "ai") => {
    panel.hidden = !panel.hidden && mode === m ? true : false;
    mode = m;
    render();
  };
  fab.addEventListener("click", () => toggle("review"));
  aiFab.addEventListener("click", () => toggle("ai"));
  store.addEventListener("change", () => {
    // Don't rebuild the panel under the reader's typing.
    if (panel.contains(document.activeElement) && document.activeElement?.localName === "textarea") return;
    render();
  });
  document.addEventListener("guide:page", () => {
    // A new page: the panel belonged to the old one.
    panel.hidden = true;
    render();
    focusPending();
  });
  render();
  focusPending();
}

// Helpers

/** Open comments with the threads an agent answered last (replies to read) first, newest reply on top. */
function repliesFirst(open: ReviewComment[]): ReviewComment[] {
  const byThread = new Map<string, ReviewComment[]>();
  for (const c of open) byThread.set(threadKey(c), [...(byThread.get(threadKey(c)) ?? []), c]);
  const replied = [...byThread.values()].filter((list) => list.at(-1)!.author).map((list) => list.at(-1)!);
  replied.sort((a, b) => b.created.localeCompare(a.created));
  const rest = open.filter((c) => !replied.includes(c));
  return [...replied, ...rest];
}

/** The note being written for the AI, kept across panel re-renders. */
let sendNote = "";
let tab: "open" | "resolved" = "open";

const FOCUS_KEY = `${settings.storageKey}:focus`;

/** Go to a comment: its page (a full load if it's another page), then the comment itself. */
export function goTo(c: ReviewComment) {
  const path = c.page ?? pages.find((p) => p.branch === c.branch)?.path;
  if (!path) return;
  sessionStorage.setItem(FOCUS_KEY, c.id);
  if (path !== window.location.pathname) window.location.href = path;
  else focusPending();
}

/** Scroll to and flash the comment `goTo` asked for, once it has rendered (diagrams and diffs render late). */
function focusPending() {
  const id = sessionStorage.getItem(FOCUS_KEY);
  if (!id) return;
  const c = comments().find((x) => x.id === id);
  if (!c) return sessionStorage.removeItem(FOCUS_KEY);
  reveal(threadKey(c));
  let tries = 0;
  const attempt = () => {
    const card = document.querySelector<HTMLElement>(`[data-comment-id="${CSS.escape(id)}"]`);
    if (card) {
      sessionStorage.removeItem(FOCUS_KEY);
      card.scrollIntoView({ block: "center" });
      card.classList.add("flash");
      setTimeout(() => card.classList.remove("flash"), 2000);
      return;
    }
    // A code comment in a file folded away as reviewed: unfold it.
    if (c.file && c.branch) {
      const section = document.getElementById(fileAnchor(c.branch, c.file));
      if (section?.classList.contains("collapsed")) section.querySelector<HTMLButtonElement>(".collapse")?.click();
    }
    if (tries++ < 60) setTimeout(attempt, 100);
    else sessionStorage.removeItem(FOCUS_KEY);
  };
  attempt();
}

function listItem(c: ReviewComment, unsent = false): string {
  const where = c.file
    ? `${c.file.split("/").at(-1)}${c.line ? (c.startLine && c.startLine !== c.line ? `:${c.startLine}-${c.line}` : `:${c.line}`) : ""}`
    : c.anchor
      ? commentPlace(c)
      : "general";
  const target = c.branch?.replace(/^stack\//, "") ?? pages.find((p) => p.path === c.page)?.title ?? c.page ?? "";
  const resolved = isResolved(threadKey(c));
  return `<li data-id="${escapeHtml(c.id)}" title="Go to this comment" class="${resolved ? "resolved" : ""}${c.author ? " from-agent" : ""}"><div class="item-where">${c.author ? `<strong>${escapeHtml(c.author)}</strong> · ` : ""}<code>${escapeHtml(target)}</code> · <code>${escapeHtml(where)}</code>${resolved ? " · resolved" : ""}${unsent ? ` <span class="sent-tag new">new</span>` : ""}
    <button type="button" class="item-delete" data-id="${escapeHtml(c.id)}" title="Delete">✕</button></div>
    <div class="item-text">${inlineMarkdown(c.text)}</div></li>`;
}

async function copy(text: string, button: HTMLElement) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard API needs a secure context (e.g. plain http on a private network).
    const area = document.createElement("textarea");
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  const label = button.textContent;
  button.textContent = "Copied";
  setTimeout(() => (button.textContent = label), 1200);
}
