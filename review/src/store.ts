// Reviewer state. View settings stay in this browser's localStorage; the
// review itself (comments, reviewed files, verdicts, section marks) is shared
// through sync.ts. Components listen for "change" on `store` (detail: the key
// or collection that changed) to refresh.

import { settings } from "./settings";
import { items, save } from "./sync";

export type DiffMode = "unified" | "split";

export interface ReviewComment {
  id: string;
  /** The branch a review page or diff is about; absent on living docs pages. */
  branch?: string;
  /** Comments on a page's text: the page's path and the block they're on. */
  page?: string;
  anchor?: PageAnchor;
  /** Code comments: the file (absent for a general comment on the branch). */
  file?: string;
  line?: number;
  /** A comment on several lines (click and drag): the first one; `line` is the last. */
  startLine?: number;
  side?: "old" | "new";
  /** The code line the comment was left on, kept for the export. */
  code?: string;
  text: string;
  created: string;
  edited?: string;
  /** "claude" for an agent's reply; absent for the reader. */
  author?: string;
  /** The thread: the id of its first comment. Older comments have none and are grouped by place. */
  thread?: string;
}

/** Where on a page a comment sits: a section (h2), a block in it, and the start of the block's text to find it again. */
export interface PageAnchor {
  section: string;
  sectionTitle: string;
  /** "heading" for the section itself, else the block's position in the section. */
  block: string;
  quote: string;
  /** For diagrams: the box the comment is about. */
  about?: string;
}

export type Verdict = "approve" | "request-changes" | "comment";

/** The overall review of a branch, like a GitHub review's verdict and summary. */
export interface BranchReview {
  verdict: Verdict | null;
  summary: string;
  /** When the reader last changed it (to tell what's been sent to the AI). */
  updated?: string;
}

export const VERDICTS: Record<Verdict, string> = {
  approve: "Approve",
  "request-changes": "Request changes",
  comment: "Comment",
};

export const store = new EventTarget();

export function diffMode(): DiffMode {
  const saved = read<DiffMode | null>("diffMode", null);
  return saved ?? (window.matchMedia("(max-width: 820px)").matches ? "unified" : "split");
}

export function setDiffMode(mode: DiffMode) {
  write("diffMode", mode);
}

/** Whitespace-only changes are hidden unless the reader turns them on. */
export function showWhitespace(): boolean {
  return read<boolean>("showWhitespace", false);
}

export function setShowWhitespace(on: boolean) {
  write("showWhitespace", on);
}

export type CodeView = "walkthrough" | "files";

export function codeView(): CodeView {
  return read<CodeView>("codeView", "walkthrough");
}

export function setCodeView(view: CodeView) {
  write("codeView", view);
}

export type Theme = "auto" | "light" | "dark";

/** "auto" follows the system's light/dark setting. */
export function theme(): Theme {
  return read<Theme>("theme", "auto");
}

export function setTheme(value: Theme) {
  write("theme", value);
}

/** Which review notes the diffs show: none, only important ones, or all down to details. */
export type NoteLevel = "none" | "important" | "detail";

export function noteLevel(): NoteLevel {
  return read<NoteLevel>("noteLevel", "detail");
}

export function setNoteLevel(level: NoteLevel) {
  write("noteLevel", level);
}

/** Whether a note of this kind shows at the reader's note level. */
export function noteShown(kind: string): boolean {
  const level = noteLevel();
  return level === "detail" || (level === "important" && kind === "important");
}

/** Whether the branch overview stays open above the code. */
export function overviewOpen(): boolean {
  return read<boolean>("overviewOpen", false);
}

export function setOverviewOpen(open: boolean) {
  write("overviewOpen", open);
}

/** Reviewed marks are tied to the file's patch, so a changed patch needs a new review. */
export function isReviewed(branch: string, file: string, patchHash: string): boolean {
  return !!items<boolean>("reviewed")[reviewKey(branch, file, patchHash)];
}

export function setReviewed(branch: string, file: string, patchHash: string, reviewed: boolean) {
  save([{ coll: "reviewed", id: reviewKey(branch, file, patchHash), value: reviewed ? true : null }]);
}

/** Every comment, oldest first. */
export function comments(): ReviewComment[] {
  return Object.values(items<ReviewComment>("comments")).sort((a, b) => a.created.localeCompare(b.created));
}

/** A new thread, or a reply when `comment.thread` names one (undefined for an older thread: its place groups it). */
export function addComment(comment: Omit<ReviewComment, "id" | "created">, reply = false): ReviewComment {
  const id = newId();
  const full = { ...comment, id, created: new Date().toISOString(), thread: reply ? comment.thread : id };
  save([{ coll: "comments", id: full.id, value: full }]);
  return full;
}

export function updateComment(id: string, text: string) {
  const c = items<ReviewComment>("comments")[id];
  if (c) save([{ coll: "comments", id, value: { ...c, text, edited: new Date().toISOString() } }]);
}

export function deleteComments(ids: Set<string>) {
  save([...ids].map((id) => ({ coll: "comments" as const, id, value: null })));
}

/** Comments that answer each other share a thread key (same as scripts/review-store.mjs). */
export function threadKey(c: Pick<ReviewComment, "thread" | "anchor" | "page" | "branch" | "file" | "side" | "line">): string {
  if (c.thread) return `t|${c.thread}`;
  if (c.anchor) return `page|${c.page}|${c.anchor.section}|${c.anchor.block}`;
  return `code|${c.branch ?? ""}|${c.file ?? ""}|${c.side ?? ""}|${c.line ?? ""}`;
}

export function isResolved(key: string): boolean {
  return !!items<boolean>("resolved")[key];
}

export function setResolved(key: string, resolved: boolean) {
  save([{ coll: "resolved", id: key, value: resolved ? true : null }]);
}

/** Whether resolved threads show on the pages (they always show in the review panel). */
export function showResolved(): boolean {
  return read<boolean>("showResolved", false);
}

export function setShowResolved(on: boolean) {
  write("showResolved", on);
}

/** Group comments into threads, oldest thread first. */
export function threadsOf(list: ReviewComment[]): ReviewComment[][] {
  const byKey = new Map<string, ReviewComment[]>();
  for (const c of list) byKey.set(threadKey(c), [...(byKey.get(threadKey(c)) ?? []), c]);
  return [...byKey.values()];
}

/** Unresolved comments: what still needs an answer or a change. */
export function openComments(): ReviewComment[] {
  return comments().filter((c) => !isResolved(threadKey(c)));
}

export type SectionMark = "good" | "needs-work";

/** The reader's verdict on one section of a page, keyed `page#section`. */
export function sectionMark(key: string): SectionMark | null {
  return items<SectionMark>("marks")[key] ?? null;
}

export function setSectionMark(key: string, mark: SectionMark | null) {
  save([{ coll: "marks", id: key, value: mark }]);
}

export function sectionMarks(): Record<string, SectionMark> {
  return items<SectionMark>("marks");
}

export function branchReview(branch: string): BranchReview {
  return items<BranchReview>("reviews")[branch] ?? { verdict: null, summary: "" };
}

export function setBranchReview(branch: string, review: BranchReview) {
  const empty = !review.verdict && !review.summary.trim();
  save([{ coll: "reviews", id: branch, value: empty ? null : { ...review, updated: new Date().toISOString() } }]);
}

/** Branches with a verdict or summary. */
export function reviewedBranches(): string[] {
  return Object.keys(items<BranchReview>("reviews"));
}

/** Markdown for pasting a review elsewhere (an issue, a chat with an agent). */
export function commentsMarkdown(list: ReviewComment[], branches: string[] = []): string {
  const byTarget = new Map<string, ReviewComment[]>();
  for (const b of branches) byTarget.set(b, []);
  for (const c of list) {
    const target = c.branch ?? c.page ?? "general";
    if (!byTarget.has(target)) byTarget.set(target, []);
    byTarget.get(target)!.push(c);
  }
  const sections = [...byTarget].map(([target, items]) => {
    const review = branchReview(target);
    const head = [
      review.verdict ? `**${VERDICTS[review.verdict]}**` : "",
      review.summary.trim(),
    ].filter(Boolean);
    const lines = items.map((c) => {
      const code = c.code ? `\n  > \`${c.code.trim()}\`` : "";
      const quote = c.anchor?.quote ? `\n  > ${c.anchor.quote}` : "";
      const who = c.author ? `**${c.author}:** ` : "";
      const text = c.text.trim().replace(/\n/g, "\n  ");
      return `- ${commentPlace(c)}${code}${quote}\n  ${who}${text}`;
    });
    return [`## ${target}`, head.join("\n\n"), lines.join("\n")].filter(Boolean).join("\n\n");
  });
  return sections.join("\n\n") + "\n";
}

/** Where a comment is, in words: `file:line`, "Section › block", or "general". */
export function commentPlace(c: ReviewComment): string {
  if (c.anchor) {
    const block = c.anchor.block === "heading" ? "" : ` › ${c.anchor.quote.slice(0, 40)}…`;
    return `"${c.anchor.sectionTitle}"${block}${c.anchor.about ? ` (about ${c.anchor.about})` : ""}`;
  }
  if (c.file) {
    const lines = c.line ? (c.startLine && c.startLine !== c.line ? `:${c.startLine}-${c.line}` : `:${c.line}`) : "";
    return `\`${c.file}${lines}\`${c.side === "old" ? ` (removed line${c.startLine ? "s" : ""})` : ""}`;
  }
  return "general";
}

export function patchHash(value: unknown): string {
  // FNV-1a over the JSON; only needs to change when the patch changes.
  let h = 0x811c9dc5;
  for (const ch of JSON.stringify(value)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

// Helpers

const PREFIX = `${settings.storageKey}:`;

/** crypto.randomUUID only exists in secure contexts (not plain http on a private network). */
function newId(): string {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function reviewKey(branch: string, file: string, patchHashValue: string): string {
  return `${branch}|${file}|${patchHashValue}`;
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  localStorage.setItem(PREFIX + key, JSON.stringify(value));
  store.dispatchEvent(new CustomEvent("change", { detail: key }));
}
