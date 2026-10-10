// Components tied to code and branches:
//   <code-ref ref="path#symbol">label</code-ref>   opens the resolved line in the code viewer
//   <review-header branch="stack/…">              branch card: position, parent, stats, progress
// The branch's code (<review-code>) is in code.ts; notes and comments in notes.ts.

import { glanceChips, glanceText } from "./glance";
import { loadBranch, pages, refs, branchIndex } from "./data";
import { escapeHtml } from "./diff";
import { branchReview, comments, isReviewed, store } from "./store";

/** The verdict as a state, at the top of a review: "Approved", not the button's "Approve". */
const VERDICT_STATE = { approve: "✓ Approved", "request-changes": "✗ Changes requested", comment: "Commented" } as const;

export class CodeRef extends HTMLElement {
  connectedCallback() {
    if (this.dataset.rendered) return;
    this.dataset.rendered = "1";
    const ref = this.getAttribute("ref") ?? "";
    const info = refs[ref];
    const a = document.createElement("a");
    a.className = "code-ref";
    const label = this.textContent?.trim() || ref.split("#")[1] || ref.split("/").at(-1) || ref;
    a.textContent = label;
    if (info?.ok) {
      // Opens in the page's code viewer (source.ts).
      a.href = "#";
      a.dataset.ref = ref;
      a.title = `${info.file}${info.line ? `:${info.line}` : ""}`;
    } else {
      a.classList.add("stale");
      a.title = `Unresolved reference: ${ref}${info?.reason ? ` (${info.reason})` : ""}`;
    }
    this.replaceChildren(a);
  }
}

export class ReviewHeader extends HTMLElement {
  connectedCallback() {
    if (this.dataset.rendered) return;
    this.dataset.rendered = "1";
    const name = this.getAttribute("branch")!;
    // Everything here comes from the small branch index, so the card draws at
    // once; the diff itself (loadBranch) is only needed by <review-code>.
    const data = branchIndex.find((b) => b.name === name) ?? null;
    // Previous / next among siblings: the stack's branches, or the branches beside it.
    const parent = pages.find((p) => p.branch === name)?.parent ?? null;
    const reviewPages = pages.filter((p) => p.branch && (p.parent ?? null) === parent);
    const idx = reviewPages.findIndex((p) => p.branch === name);
    const prev = idx > 0 ? reviewPages[idx - 1] : null;
    const next = idx >= 0 && idx < reviewPages.length - 1 ? reviewPages[idx + 1] : null;
    const added = data?.added ?? 0;
    const removed = data?.removed ?? 0;
    const risk = this.getAttribute("risk") ?? "";
    const page = pages.find((p) => p.branch === name && p.path === location.pathname) ?? pages.find((p) => p.branch === name);
    const title = page?.title.replace(/^[^·]{1,6} · /, "") ?? data?.subject ?? "(branch data not generated — run pnpm gen)";
    const short = (p: (typeof pages)[number]) => (p.title.includes(" · ") ? p.title.split(" · ")[0] : (p.branch ?? p.title));
    const commitCount = data?.commitCount ?? 0;
    this.innerHTML = `
      <div class="review-card">
        <div class="rc-top">
          <span class="branch-name">${escapeHtml(name)}</span>
          ${data?.merged ? `<span class="merged-badge">merged</span>` : ""}
          <span class="rc-verdict"></span>
          <span class="rc-glance">${page ? glanceChips({ ...page, risk: risk || page.risk }) : ""}</span>
        </div>
        <div class="review-subject">${escapeHtml(title)}</div>
        ${page && !document.querySelector("review-summary") ? glanceText(page) : ""}
        <div class="review-meta">
          <span>on <code>${escapeHtml(data?.parent ?? "?")}</code></span>
          ${commitCount ? `<button type="button" class="rc-commits-toggle">${commitCount} commit${commitCount > 1 ? "s" : ""} ▾</button>` : ""}
          <span>${data?.files.length ?? 0} files <span class="added">+${added}</span> <span class="removed">−${removed}</span></span>
          <a class="progress" href="#code"></a>
          <span class="rc-nav">
            ${prev ? `<a href="${prev.path}" title="${escapeHtml(prev.title)}">← ${escapeHtml(short(prev))}</a>` : ""}
            ${next ? `<a href="${next.path}" title="${escapeHtml(next.title)}">${escapeHtml(short(next))} →</a>` : ""}
          </span>
        </div>
        <ol class="rc-commits" hidden></ol>
      </div>
      <div class="rc-sticky" hidden>
        <span class="rc-sticky-title"><strong>${escapeHtml(page ? short(page) : name)}</strong> ${escapeHtml(title)}</span>
        <span class="rc-verdict"></span>
        <span class="rc-nav">
          ${prev ? `<a href="${prev.path}" title="${escapeHtml(prev.title)}">← ${escapeHtml(short(prev))}</a>` : ""}
          ${next ? `<a href="${next.path}" title="${escapeHtml(next.title)}">${escapeHtml(short(next))} →</a>` : ""}
        </span>
      </div>`;
    // Once the card scrolls away, a slim bar keeps the branch, its verdict and previous / next in view.
    const card = this.querySelector<HTMLElement>(".review-card")!;
    const bar = this.querySelector<HTMLElement>(".rc-sticky")!;
    new IntersectionObserver(([entry]) => (bar.hidden = entry.isIntersecting || entry.boundingClientRect.top > 0)).observe(card);
    // The commit messages live with the diff; fetch them on the first open.
    const toggle = this.querySelector<HTMLButtonElement>(".rc-commits-toggle");
    const list = this.querySelector<HTMLElement>(".rc-commits")!;
    if (toggle)
      toggle.onclick = async () => {
        if (!list.childElementCount) list.innerHTML = commitList((await loadBranch(name))?.commits ?? []);
        list.hidden = !list.hidden;
      };
    if (!data) return;
    const progress = this.querySelector<HTMLElement>(".progress")!;
    const update = () => {
      if (!this.isConnected && this.dataset.mounted) return store.removeEventListener("change", update);
      const done = data.files.filter((f) => isReviewed(name, f.file, f.hash)).length;
      const mine = comments().filter((c) => c.branch === name).length;
      const verdict = branchReview(name).verdict;
      for (const badge of this.querySelectorAll<HTMLElement>(".rc-verdict")) {
        badge.className = `rc-verdict rc-verdict-${verdict ?? "none"}`;
        badge.textContent = verdict ? VERDICT_STATE[verdict] : "Not reviewed yet";
      }
      progress.textContent = `${done}/${data.files.length} reviewed${mine ? ` · ${mine} comment${mine === 1 ? "" : "s"}` : ""}`;
      progress.classList.toggle("done", done === data.files.length);
    };
    store.addEventListener("change", update);
    queueMicrotask(() => (this.dataset.mounted = "1"));
    update();
  }
}

/** The branch's commits, hidden until the "N commits" toggle; a message body only when there is one. */
function commitList(commits: { hash: string; subject: string; body: string }[]): string {
  if (!commits.length) return "";
  const items = commits
    .map((c) => `<li><code>${escapeHtml(c.hash.slice(0, 7))}</code> ${escapeHtml(c.subject)}${c.body.trim() ? `<pre class="commit-body">${escapeHtml(c.body.trim())}</pre>` : ""}</li>`)
    .join("");
  return items;
}
