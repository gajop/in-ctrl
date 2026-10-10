// Talking to the agent through the guide, and taking its updates:
//   - "Send to AI" (in the review panel) files a request in the inbox
//     (`in-ctrl review inbox`); its state shows until the agent marks it done.
//   - The agent publishes the guide as a new release (`in-ctrl review publish`). Open
//     pages keep what they have and show a "Reload" bar; links then load
//     whole pages, so old and new never mix. Nothing reloads on its own.

import { escapeHtml, inlineMarkdown } from "./diff";
import { store } from "./store";
import { refresh } from "./sync";

export interface InboxRequest {
  id: string;
  at: string;
  note: string;
  status: "pending" | "working" | "done";
  reply?: string;
}

/** Start watching for new releases and inbox changes. */
export function installLive() {
  void check();
  // The server says when something changed; polling is only a fallback.
  const events = new EventSource("/_in-ctrl/events");
  events.onmessage = () => {
    void check();
    void refresh();
  };
  window.addEventListener("focus", () => void check());
  setInterval(() => {
    if (document.visibilityState === "visible") void check();
  }, 60_000);
}

export function inbox(): InboxRequest[] {
  return requests;
}

export async function sendToAi(note: string) {
  const res = await fetch("/_in-ctrl/inbox", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ note }) });
  if (!res.ok) throw new Error(String(res.status));
  requests = (await res.json()) as InboxRequest[];
  store.dispatchEvent(new CustomEvent("change", { detail: "inbox" }));
}

/** When the reader last pressed Send (null if never). */
export function lastSent(): string | null {
  return requests.length ? requests[requests.length - 1].at : null;
}

/** A request the AI hasn't finished yet, if any. */
export function inFlight(): InboxRequest | null {
  return requests.find((r) => r.status !== "done") ?? null;
}

/** True once a newer release is live: links should load whole pages. */
export function outdated(): boolean {
  return loadedVersion !== null && latestVersion !== null && latestVersion !== loadedVersion;
}

/** The inbox as HTML for the review panel: the latest requests, newest first. */
export function inboxHtml(): string {
  const label = { pending: "Sent, waiting for the AI", working: "The AI is working on it", done: "Done" } as const;
  return requests
    .slice(-3)
    .reverse()
    .map(
      (r) => `<li class="inbox-${r.status}"><div class="item-where"><strong>${label[r.status]}</strong> · ${escapeHtml(new Date(r.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }))}</div>
        ${r.note ? `<div class="item-text">${inlineMarkdown(r.note)}</div>` : ""}
        ${r.reply ? `<div class="item-text inbox-reply">${inlineMarkdown(r.reply)}</div>` : ""}</li>`,
    )
    .join("");
}

// Helpers

let requests: InboxRequest[] = [];
let loadedVersion: string | null = null;
let latestVersion: string | null = null;

async function check() {
  const [version, list] = await Promise.all([getJson<{ version: string }>("/_in-ctrl/version"), getJson<InboxRequest[]>("/_in-ctrl/inbox")]);
  if (version) {
    loadedVersion ??= version.version;
    latestVersion = version.version;
    if (outdated()) showReloadBar();
  }
  if (list && JSON.stringify(list) !== JSON.stringify(requests)) {
    requests = list;
    store.dispatchEvent(new CustomEvent("change", { detail: "inbox" }));
  }
}

/** JSON from the guide's server, or null (e.g. under the dev server, which has no such route). */
async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok || !res.headers.get("Content-Type")?.includes("json")) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function showReloadBar() {
  if (document.querySelector(".reload-bar")) return;
  const bar = document.createElement("div");
  bar.className = "reload-bar";
  bar.innerHTML = `The docs were updated. <button type="button">Reload</button> <span class="muted">(your comments are saved)</span>`;
  bar.querySelector("button")!.addEventListener("click", () => window.location.reload());
  document.body.append(bar);
}
