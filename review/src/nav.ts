import { settings } from "./settings";
import { goTo } from "./notes";
import type { ReviewComment } from "./store";
// <guide-nav>: sidebar with every page, grouped by section, current page marked,
// and how the review of each page is going.

import { pages, branchIndex } from "./data";
import { escapeHtml } from "./diff";
import { branchReview, comments, isResolved, isReviewed, sectionMarks, store, threadKey } from "./store";
import { themeButton } from "./theme";

const SECTIONS: Record<string, string> = {
  guide: "User guide",
  living: "Developer docs",
  review: "Review",
  meta: "About these docs",
};

export class GuideNav extends HTMLElement {
  connectedCallback() {
    const groups = new Map<string, typeof pages>();
    for (const p of pages) {
      if (!groups.has(p.section)) groups.set(p.section, []);
      groups.get(p.section)!.push(p);
    }
    const order = ["guide", "living", "review", "meta", ...[...groups.keys()].filter((k) => !(k in SECTIONS))];
    this.addMobileBar();
    this.addEventListener("guide:navigated", () => this.markCurrent());
    const closedSections = new Set(readList("navClosedSections"));
    this.innerHTML = `
      <div class="nav-top"><a class="nav-home" href="/">${escapeHtml(settings.title)}</a><span class="nav-theme"></span><button type="button" class="nav-collapse" title="Hide sidebar">«</button></div>
      ${order
        .filter((s) => groups.has(s))
        .map(
          (s) => `<details class="nav-section" data-section="${escapeHtml(s)}" ${closedSections.has(s) ? "" : "open"}>
            <summary class="nav-section-title">${escapeHtml(SECTIONS[s] ?? s)}<span class="nav-section-status" data-section="${escapeHtml(s)}"></span></summary>
            ${tree(groups.get(s)!)}
          </details>`,
        )
        .join("")}`;
    this.querySelector(".nav-theme")!.replaceWith(themeButton());
    for (const section of this.querySelectorAll<HTMLDetailsElement>(".nav-section")) {
      section.addEventListener("toggle", () => {
        const closed = [...this.querySelectorAll<HTMLDetailsElement>(".nav-section:not([open])")].map(
          (d) => d.dataset.section!,
        );
        writeList("navClosedSections", closed);
      });
    }
    // Subpage trees open and close with their caret; the state is kept.
    for (const caret of this.querySelectorAll<HTMLButtonElement>(".nav-caret")) {
      caret.addEventListener("click", () => {
        const group = caret.closest<HTMLElement>(".nav-group")!;
        group.classList.toggle("open");
        const open = new Set(readList("navOpenGroups"));
        if (group.classList.contains("open")) open.add(group.dataset.group!);
        else open.delete(group.dataset.group!);
        writeList("navOpenGroups", [...open]);
      });
    }
    this.addSidebarToggle();
    this.markCurrent();
    this.renderStatus();
    store.addEventListener("change", (e) => {
      if (["comments", "reviewed", "reviews", "marks", "resolved"].includes((e as CustomEvent<string>).detail)) this.renderStatus();
    });
  }

  /** Per page: the verdict, files reviewed, section marks, open threads and agent replies waiting for the reader. */
  renderStatus() {
    const threads = openThreads();
    const marks = Object.entries(sectionMarks());
    let approved = 0;
    let reviews = 0;
    for (const el of this.querySelectorAll<HTMLElement>(".nav-status")) {
      const page = pages.find((p) => p.path === el.dataset.page)!;
      const parts: string[] = [];
      const titles: string[] = [];
      if (page.branch) {
        const inStack = page.parent === "/pages/review/index.html";
        if (inStack) reviews++;
        const verdict = branchReview(page.branch).verdict;
        const data = branchIndex.find((b) => b.name === page.branch);
        const merged = data?.merged;
        if (verdict === "approve" && inStack) approved++;
        if (merged) {
          parts.push(`<span class="st merged">merged</span>`);
          titles.push(`Merged into ${settings.baseBranch}`);
        } else if (verdict) {
          parts.push(`<span class="st verdict-${verdict}">${VERDICT_ICON[verdict]}</span>`);
          titles.push(VERDICT_TITLE[verdict]);
        }
        const files = data?.files ?? [];
        const done = files.filter((f) => isReviewed(page.branch!, f.file, f.hash)).length;
        if (done) {
          parts.push(`<span class="st files${done === files.length ? " done" : ""}">${done}/${files.length}</span>`);
          titles.push(`${done} of ${files.length} files reviewed`);
        }
      }
      const good = marks.filter(([k, v]) => k.startsWith(`${page.path}#`) && v === "good").length;
      const bad = marks.filter(([k, v]) => k.startsWith(`${page.path}#`) && v === "needs-work").length;
      if (bad) parts.push(`<span class="st needs-work">✗${bad}</span>`), titles.push(`${bad} sections need work`);
      if (good && !page.branch) parts.push(`<span class="st good">✓${good}</span>`), titles.push(`${good} sections look good`);
      const mine = threads.filter((t) => t.page === page.path || (page.branch && t.branch === page.branch));
      const replies = mine.filter((t) => t.lastByAgent).length;
      if (replies) parts.push(`<span class="st reply" data-reply-page="${escapeHtml(page.path)}" title="Go to the reply">↩${replies}</span>`), titles.push(`${replies} ${replies === 1 ? "reply" : "replies"} to read (click ↩ to go there)`);
      if (mine.length - replies) parts.push(`<span class="st open">💬${mine.length - replies}</span>`), titles.push(`${mine.length - replies} open threads`);
      el.innerHTML = parts.join("");
      el.title = titles.join(", ");
    }
    // ↩ goes straight to the newest reply on that page.
    for (const badge of this.querySelectorAll<HTMLElement>("[data-reply-page]")) {
      badge.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const path = badge.dataset.replyPage!;
        const page = pages.find((p) => p.path === path);
        const reply = threads
          .filter((t) => t.lastByAgent && (t.page === path || (page?.branch && t.branch === page.branch)))
          .map((t) => t.last)
          .sort((a, b) => b.created.localeCompare(a.created))[0];
        if (reply) goTo(reply);
      };
    }
    const review = this.querySelector<HTMLElement>('.nav-section-status[data-section="review"]');
    if (review) review.textContent = reviews ? ` · ${approved}/${reviews} approved` : "";
  }

  /** Highlight the current page and title the mobile bar (also after client-side navigation). */
  markCurrent() {
    const here = window.location.pathname;
    let current: HTMLElement | null = null;
    for (const link of this.querySelectorAll<HTMLAnchorElement>(".nav-link")) {
      const isCurrent = new URL(link.href).pathname === here;
      link.classList.toggle("current", isCurrent);
      if (isCurrent) current = link;
    }
    // The tree around the current page opens.
    for (let group = current?.closest<HTMLElement>(".nav-group"); group; group = group.parentElement?.closest<HTMLElement>(".nav-group")) {
      group.classList.add("open");
    }
    const title = document.querySelector(".mobile-title");
    if (title) title.textContent = current?.textContent ?? settings.title;
    // Keep the current link visible in the sidebar without scrolling the page.
    if (current && (current.offsetTop < this.scrollTop || current.offsetTop > this.scrollTop + this.clientHeight - 40)) {
      this.scrollTop = current.offsetTop - this.clientHeight / 3;
    }
  }

  /** Narrow screens: a top bar with a menu button that slides the sidebar in. */
  private addMobileBar() {
    if (document.querySelector(".mobile-bar")) return;
    const bar = document.createElement("header");
    bar.className = "mobile-bar";
    const current = pages.find((p) => p.path === window.location.pathname);
    bar.innerHTML = `<button type="button" class="menu" aria-label="Menu">☰</button><span class="mobile-title">${escapeHtml(current?.title ?? settings.title)}</span>`;
    bar.append(themeButton());
    const backdrop = document.createElement("div");
    backdrop.className = "nav-backdrop";
    const toggle = (open?: boolean) => document.body.classList.toggle("nav-open", open);
    bar.querySelector("button")!.addEventListener("click", () => toggle());
    backdrop.addEventListener("click", () => toggle(false));
    this.addEventListener("click", (e) => {
      if ((e.target as Element).closest("a")) toggle(false);
    });
    document.body.prepend(bar, backdrop);
  }

  /** Desktop: « hides the sidebar, a » button brings it back; remembered per browser. */
  private addSidebarToggle() {
    const reopen = document.querySelector<HTMLButtonElement>(".nav-reopen") ?? document.createElement("button");
    reopen.type = "button";
    reopen.className = "nav-reopen";
    reopen.title = "Show sidebar";
    reopen.textContent = "»";
    if (!reopen.isConnected) document.body.append(reopen);
    const set = (hidden: boolean) => {
      document.body.classList.toggle("nav-hidden", hidden);
      writeList("navHidden", hidden ? ["1"] : []);
    };
    set(readList("navHidden").length > 0);
    this.querySelector(".nav-collapse")!.addEventListener("click", () => set(true));
    reopen.onclick = () => set(false);
  }
}

// Helpers

/** The pages of a section as a tree: a page with subpages gets a caret that opens and closes them. */
function tree(list: typeof pages): string {
  const openGroups = new Set(readList("navOpenGroups"));
  const link = (p: (typeof pages)[number]) =>
    `<a class="nav-link" href="${p.path}" title="${escapeHtml(p.oneliner?.replace(/\*\*|`/g, "") || p.summary)}"><span class="nav-title">${escapeHtml(p.title)}${diffstat(p.branch)}</span><span class="nav-status" data-page="${escapeHtml(p.path)}"></span></a>`;
  const render = (p: (typeof pages)[number]): string => {
    const children = list.filter((q) => q.parent === p.path);
    if (!children.length) return link(p);
    return `<div class="nav-group${openGroups.has(p.path) ? " open" : ""}" data-group="${escapeHtml(p.path)}">
      <div class="nav-group-head"><button type="button" class="nav-caret" title="Show or hide subpages">▸</button>${link(p)}</div>
      <div class="nav-children">${children.map(render).join("")}</div></div>`;
  };
  return list.filter((p) => !p.parent || !list.some((q) => q.path === p.parent)).map(render).join("");
}

/** A branch's lines added and removed, after its title: +417 −7. */
function diffstat(branch?: string | null): string {
  const data = branch ? branchIndex.find((b) => b.name === branch) : undefined;
  if (!data) return "";
  const files = `${data.files.length} file${data.files.length === 1 ? "" : "s"}`;
  return ` <span class="nav-diffstat" title="+${data.added} −${data.removed} lines in ${files}"><span class="added">+${short(data.added)}</span> <span class="removed">−${short(data.removed)}</span></span>`;
}

/** Line counts that fit the sidebar: 417, 3.6k, 21k. */
function short(n: number): string {
  if (n < 1000) return String(n);
  return n < 10000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : `${Math.round(n / 1000)}k`;
}

const VERDICT_ICON = { approve: "✓", "request-changes": "✗", comment: "💬" } as const;
const VERDICT_TITLE = { approve: "Approved", "request-changes": "Changes requested", comment: "Commented" } as const;

/** Unresolved threads: where they are, and whether an agent answered last. */
function openThreads(): { page?: string; branch?: string; lastByAgent: boolean; last: ReviewComment }[] {
  const byKey = new Map<string, ReturnType<typeof comments>>();
  for (const c of comments()) {
    const key = threadKey(c);
    if (isResolved(key)) continue;
    byKey.set(key, [...(byKey.get(key) ?? []), c]);
  }
  return [...byKey.values()].map((list) => ({
    page: list[0].page,
    branch: list[0].branch,
    lastByAgent: !!list.at(-1)!.author,
    last: list.at(-1)!,
  }));
}

function readList(key: string): string[] {
  try {
    return JSON.parse(localStorage.getItem(`${settings.storageKey}:${key}`) ?? "[]") as string[];
  } catch {
    return [];
  }
}

function writeList(key: string, value: string[]) {
  localStorage.setItem(`${settings.storageKey}:${key}`, JSON.stringify(value));
}
