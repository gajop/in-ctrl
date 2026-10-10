// The review (comments, reviewed files, verdicts, section marks, resolved
// threads) lives on the machine serving the guide, behind /_in-ctrl/comments
// (src/node/comments.mjs, the same store as the docs site's comments), so the
// PC and the phone share it and an agent can read it and reply. Without that
// API (a static copy of the build) it falls back to this browser's localStorage.
//
// Changes apply locally at once and are sent as ops; the page re-reads the
// review when the server says it changed (live.ts), on focus, and every minute.

import { settings } from "./settings";
import { store } from "./store";

const API = "/_in-ctrl/comments";

export type Collection = "comments" | "reviewed" | "reviews" | "marks" | "resolved";
export interface Op {
  coll: Collection;
  id: string;
  value: unknown;
}

const COLLECTIONS: Collection[] = ["comments", "reviewed", "reviews", "marks", "resolved"];

/** Load the review before the page renders. */
export async function loadReview() {
  try {
    const res = await fetch(API, { cache: "no-store" });
    if (!res.ok) throw new Error(String(res.status));
    state = normalize(await res.json());
    online = true;
  } catch {
    state = normalize(JSON.parse(localStorage.getItem(LOCAL_KEY) ?? "{}"));
  }
  // live.ts refreshes on the server's change events; this is the fallback.
  window.addEventListener("focus", () => void refresh());
  setInterval(() => {
    if (document.visibilityState === "visible") void refresh();
  }, 60_000);
}

export function items<T>(coll: Collection): Record<string, T> {
  return state[coll] as Record<string, T>;
}

export function save(ops: Op[]) {
  if (!ops.length) return;
  for (const { coll, id, value } of ops) {
    if (value === null) delete state[coll][id];
    else state[coll][id] = value;
  }
  announce(new Set(ops.map((o) => o.coll)));
  if (!online) {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(state));
    return;
  }
  fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(ops) })
    .then((res) => {
      if (!res.ok) throw new Error(String(res.status));
    })
    .catch(() => alert("Couldn't save the review: is the guide server running?"));
}

/** Where the review is kept, for the comments panel. */
export function reviewLocation(): string {
  return online ? "saved on the guide's machine" : "saved in this browser only";
}

// Helpers

const LOCAL_KEY = `${settings.storageKey}:review`;
let state = normalize({});
let online = false;

function normalize(raw: Record<string, unknown>): Record<Collection, Record<string, unknown>> {
  return Object.fromEntries(
    COLLECTIONS.map((c) => [c, (raw?.[c] as Record<string, unknown>) ?? {}]),
  ) as Record<Collection, Record<string, unknown>>;
}

/** Re-read the review and announce what changed. */
export async function refresh() {
  if (!online) return;
  try {
    const res = await fetch(API, { cache: "no-store" });
    if (!res.ok) return;
    const next = normalize(await res.json());
    const changed = new Set(COLLECTIONS.filter((c) => JSON.stringify(next[c]) !== JSON.stringify(state[c])));
    state = next;
    announce(changed);
  } catch {
    // Offline for a moment; the next refresh retries.
  }
}

function announce(colls: Set<Collection>) {
  for (const coll of colls) store.dispatchEvent(new CustomEvent("change", { detail: coll }));
}
