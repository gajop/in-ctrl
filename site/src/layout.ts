// On every page: buttons in the header that hide or show the sidebar and the
// table of contents ("[" and "]" do the same from the keyboard). The choice is
// kept in localStorage and set on <html> before paint (src/node/site.mjs), so
// pages don't flash; the CSS that frees the width is in styles.css.

type Part = "sidebar" | "toc";

const PARTS: Record<Part, { attr: string; has: string; key: string; label: string; icon: string }> = {
  sidebar: {
    attr: "icSidebar",
    has: "hasSidebar",
    key: "[",
    label: "Sidebar",
    icon: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><line x1="9" y1="4" x2="9" y2="20" stroke="currentColor" stroke-width="1.8"/></svg>',
  },
  toc: {
    attr: "icToc",
    has: "hasToc",
    key: "]",
    label: "Contents",
    icon: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><line x1="15" y1="4" x2="15" y2="20" stroke="currentColor" stroke-width="1.8"/></svg>',
  },
};

const root = document.documentElement;
const hidden = (part: Part) => root.dataset[PARTS[part].attr] === "hidden";

function set(part: Part, hide: boolean) {
  const { attr } = PARTS[part];
  if (hide) root.dataset[attr] = "hidden";
  else delete root.dataset[attr];
  try {
    localStorage.setItem(`in-ctrl:${part}`, hide ? "hidden" : "shown");
  } catch {}
  for (const button of document.querySelectorAll<HTMLButtonElement>(`.ic-toggle[data-part="${part}"]`)) sync(button, part);
}

function sync(button: HTMLButtonElement, part: Part) {
  const shown = !hidden(part);
  button.setAttribute("aria-pressed", String(shown));
  const what = PARTS[part].label.toLowerCase();
  button.title = `${shown ? "Hide" : "Show"} the ${what === "contents" ? "table of contents" : what} (${PARTS[part].key})`;
  button.setAttribute("aria-label", button.title);
}

function buttons() {
  const group = document.querySelector(".header .right-group");
  if (!group || group.querySelector(".ic-toggles")) return;
  const box = document.createElement("div");
  box.className = "ic-toggles";
  for (const part of Object.keys(PARTS) as Part[]) {
    if (root.dataset[PARTS[part].has] === undefined) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ic-toggle";
    button.dataset.part = part;
    button.innerHTML = PARTS[part].icon;
    button.addEventListener("click", () => set(part, !hidden(part)));
    sync(button, part);
    box.append(button);
  }
  if (box.childElementCount) group.prepend(box);
}

function typing(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

document.addEventListener("keydown", (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey || typing(event.target)) return;
  for (const part of Object.keys(PARTS) as Part[]) {
    if (event.key === PARTS[part].key && root.dataset[PARTS[part].has] !== undefined) {
      set(part, !hidden(part));
      event.preventDefault();
    }
  }
});

buttons();
document.addEventListener("astro:page-load", buttons);
