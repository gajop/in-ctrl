// "Send to the agent": the reader asks an agent to act on the open review
// items, with an optional note. Requests live in one JSON file (review.inbox,
// default .in-ctrl/inbox.json); the review shows their state (pending →
// working → done, with the agent's summary).
//
//   in-ctrl review inbox wait             block until a request is pending, print it, exit
//   in-ctrl review inbox start ID         mark it as being worked on
//   in-ctrl review inbox done ID TEXT     mark it done, with a summary for the reader

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** The most a request's note keeps. */
const MAX_NOTE = 4000;

export function readInbox(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

function writeInbox(file, list) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 1));
  fs.renameSync(tmp, file);
}

/** Change request `id` (or an id prefix); returns it. */
export function updateRequest(file, id, change) {
  const list = readInbox(file);
  const hits = list.filter((r) => r.id.startsWith(id ?? ""));
  if (hits.length !== 1) throw new Error(`${hits.length} requests match ${id ?? "(no id)"}`);
  Object.assign(hits[0], change);
  writeInbox(file, list);
  return hits[0];
}

/** Wait until a request is pending; returns the pending ones. */
export async function waitForRequest(file, interval = 3000) {
  for (;;) {
    const pending = readInbox(file).filter((r) => r.status === "pending");
    if (pending.length) return pending;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

/** GET /_in-ctrl/inbox: the requests; POST {note}: a new request. Returns true if the request was the inbox's. */
export function inboxApi(file) {
  return (req, res) => {
    if (req.url?.split("?")[0] !== "/_in-ctrl/inbox") return false;
    const send = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET") {
      send(200, readInbox(file));
      return true;
    }
    if (req.method !== "POST") {
      send(405, { error: "GET or POST" });
      return true;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const { note = "" } = JSON.parse(body || "{}");
        const list = readInbox(file);
        list.push({ id: crypto.randomUUID(), at: new Date().toISOString(), note: String(note).slice(0, MAX_NOTE), status: "pending" });
        writeInbox(file, list);
        send(200, list);
      } catch (err) {
        send(400, { error: String(err.message ?? err) });
      }
    });
    return true;
  };
}
