// Client-side navigation between guide pages: swap <main> instead of reloading,
// so the sidebar, scripts and model stay loaded and page changes are instant.
// Pages are prefetched when a link is hovered or touched.

import { outdated } from "./live";
import { resetPageModel } from "./data";

const cache = new Map<string, Promise<string>>();

export function installRouter() {
  document.addEventListener("click", (e) => {
    const link = (e.target as Element).closest("a");
    const url = link && internalUrl(link, e);
    if (!url) return;
    e.preventDefault();
    void navigate(url, true);
  });
  const warm = (e: Event) => {
    const link = (e.target as Element).closest?.("a");
    const url = link && internalUrl(link);
    if (url) fetchPage(url);
  };
  document.addEventListener("pointerover", warm, { passive: true });
  document.addEventListener("touchstart", warm, { passive: true });
  window.addEventListener("popstate", () => void navigate(new URL(window.location.href), false));
}

// Helpers

function internalUrl(link: HTMLAnchorElement, e?: MouseEvent): URL | null {
  if (e && (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)) return null;
  if (link.target || link.hasAttribute("download") || link.getAttribute("href")?.startsWith("#")) return null;
  const url = new URL(link.href, window.location.href);
  if (url.origin !== window.location.origin) return null;
  if (!(url.pathname.endsWith(".html") || url.pathname.endsWith("/"))) return null;
  if (url.pathname === window.location.pathname && url.hash) return null;
  return url;
}

function fetchPage(url: URL): Promise<string> {
  const key = url.pathname;
  if (!cache.has(key)) {
    const request = fetch(key).then((r) => {
      if (!r.ok) throw new Error(`${r.status}`);
      return r.text();
    });
    request.catch(() => cache.delete(key));
    cache.set(key, request);
  }
  return cache.get(key)!;
}

async function navigate(url: URL, push: boolean) {
  document.body.classList.remove("nav-open");
  // A newer release is live: load the whole page so old code never renders new pages.
  if (outdated()) {
    window.location.href = url.href;
    return;
  }
  let html: string;
  try {
    html = await fetchPage(url);
  } catch {
    window.location.href = url.href;
    return;
  }
  const next = new DOMParser().parseFromString(html, "text/html");
  const main = next.querySelector("main");
  const current = document.querySelector("main");
  if (!main || !current) {
    window.location.href = url.href;
    return;
  }
  if (push) history.pushState(null, "", url.href);
  document.title = next.title;
  resetPageModel();
  current.replaceWith(document.importNode(main, true));
  document.querySelector("guide-nav")?.dispatchEvent(new Event("guide:navigated"));
  document.dispatchEvent(new Event("guide:page"));
  const target = url.hash ? document.getElementById(decodeURIComponent(url.hash.slice(1))) : null;
  if (target) target.scrollIntoView();
  else window.scrollTo(0, 0);
}
