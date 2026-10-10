// <docs-diagram file="docs/…/x.diagram.yaml">: an architecture or deployment
// diagram from the repository, drawn by in-ctrl's diagrams (React Flow +
// ELK, product icons), interactive and in the guide's theme. An inline <script type="application/yaml"> may give the
// diagram instead of a file. Repo Markdown that embeds a diagram's PNG gets
// this element instead (gen-data.mjs).
//
// A review shows how a branch changes a diagram: an inline
// <script type="application/yaml" data-before> holds the diagram as it was,
// and the element draws it above the new one, with what the branch removed
// marked red in the old one and what it added marked green in the new one.

import { type ReactNode, StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import YAML from "yaml";
import { Diagram, type DiagramSpec, addIcons, setVocabulary } from "../../src/diagram/index";
import diagramCss from "../../src/diagram/diagram.css?inline";
import flowCss from "@xyflow/react/dist/style.css?inline";
import diagrams from "/generated/diagrams.json";
import docPages from "/generated/doc-pages.json";
import guideIcons from "/generated/guide-icons.json";
import vocabulary from "/generated/vocabulary.json";
import { store } from "./store";

const roots = new WeakMap<HTMLElement, Root>();
addIcons(guideIcons as Record<string, string>);
setVocabulary(vocabulary as Record<string, { label: string; icon?: string }>);

export function mountDiagram(host: HTMLElement) {
  if (roots.has(host)) return;
  const file = host.getAttribute("file");
  const inline = host.querySelector('script[type="application/yaml"]:not([data-before])')?.textContent;
  const before = host.querySelector('script[type="application/yaml"][data-before]')?.textContent;
  const source = inline ?? (file ? (diagrams as Record<string, string>)[file] : undefined);
  const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `${flowCss}\n${diagramCss}\n${CHANGE_CSS}\n:host { display: block; margin: 16px 0; }`;
  const mount = document.createElement("div");
  shadow.replaceChildren(style, mount);
  const root = createRoot(mount);
  roots.set(host, root);
  if (!source) {
    mount.textContent = `No diagram ${file ?? ""}.`;
    return;
  }
  const spec = YAML.parse(source) as DiagramSpec;
  const onLink = (link: string) => follow(link, file);
  if (!before) {
    root.render(
      <StrictMode>
        <Themed spec={spec} onLink={onLink} />
      </StrictMode>,
    );
    return;
  }
  const old = YAML.parse(before) as DiagramSpec;
  root.render(
    <StrictMode>
      <DiffView old={old} now={spec} onLink={onLink} />
    </StrictMode>,
  );
}

type View = "unified" | "before" | "after";

/** A changed diagram three ways: unified (the new one, with what was removed put back; + added, − removed, ~ changed), before, after. */
function DiffView({ old, now, onLink }: { old: DiagramSpec; now: DiagramSpec; onLink: (link: string) => void }) {
  const [view, setView] = useState<View>("unified");
  const unified = useMemo(() => unify(old, now), [old, now]);
  const [was, is] = useMemo(() => [parts(old), parts(now)], [old, now]);
  const removed = useMemo(() => new Set([...was].filter((k) => !is.has(k))), [was, is]);
  const added = useMemo(() => new Set([...is].filter((k) => !was.has(k))), [was, is]);
  return (
    <div>
      <div className="dc-tabs" role="tablist">
        {(["unified", "before", "after"] as View[]).map((v) => (
          <button key={v} type="button" role="tab" aria-selected={view === v} className={view === v ? "on" : ""} onClick={() => setView(v)}>
            {v === "unified" ? "Unified" : v === "before" ? "Before" : "After"}
          </button>
        ))}
        <span className="dc-legend">
          <span className="dc-l-added">+ added</span> <span className="dc-l-removed">− removed</span> <span className="dc-l-changed">~ changed</span>
        </span>
      </div>
      {view === "unified" && (
        <Marked marks={unified.marks} tone="unified" key="u">
          <Themed spec={unified.spec} onLink={onLink} />
        </Marked>
      )}
      {view === "before" && (
        <Marked marks={removed} tone="removed" key="b">
          <Themed spec={old} onLink={onLink} />
        </Marked>
      )}
      {view === "after" && (
        <Marked marks={added} tone="added" key="a">
          <Themed spec={now} onLink={onLink} />
        </Marked>
      )}
    </div>
  );
}

const MARK = { added: "+ ", removed: "− ", changed: "~ " } as const;
type Change = keyof typeof MARK;
type Obj = Record<string, unknown>;

/** The unified diagram: the new spec with removed parts put back, every changed label prefixed with + − or ~; `marks` names graph nodes by change ("node:<change>:<id>"). */
function unify(old: DiagramSpec, now: DiagramSpec): { spec: DiagramSpec; marks: Set<string> } {
  const marks = new Set<string>();
  const o = old as unknown as Obj;
  const n = now as unknown as Obj;
  if (Array.isArray(n.steps)) {
    return { spec: { ...n, steps: unifySteps((o.steps as Obj[]) ?? [], n.steps as Obj[]) } as unknown as DiagramSpec, marks };
  }
  const vocab = vocabulary as Record<string, { label: string }>;
  const label = (node: Obj) => String(node.label ?? (node.is ? vocab[String(node.is)]?.label : undefined) ?? node.id);
  const oldNodes = new Map(((o.nodes as Obj[]) ?? []).map((x) => [String(x.id), x]));
  const newIds = new Set(((n.nodes as Obj[]) ?? []).map((x) => String(x.id)));
  const nodes: Obj[] = [];
  for (const node of (n.nodes as Obj[]) ?? []) {
    const before = oldNodes.get(String(node.id));
    const change: Change | null = !before ? "added" : JSON.stringify(before) !== JSON.stringify(node) ? "changed" : null;
    if (change) marks.add(`node:${change}:${node.id}`);
    nodes.push(change ? { ...node, label: MARK[change] + label(node) } : node);
  }
  for (const [id, node] of oldNodes) {
    if (newIds.has(id)) continue;
    marks.add(`node:removed:${id}`);
    nodes.push({ ...node, label: MARK.removed + label(node) });
  }
  const edgeKey = (e: Obj) => `${e.from}>${e.to}:${e.label ?? ""}`;
  const oldEdges = new Set(((o.edges as Obj[]) ?? []).map(edgeKey));
  const newEdges = new Set(((n.edges as Obj[]) ?? []).map(edgeKey));
  const edges: Obj[] = [
    ...((n.edges as Obj[]) ?? []).map((e) => (oldEdges.has(edgeKey(e)) ? e : { ...e, label: MARK.added + String(e.label ?? "") })),
    ...((o.edges as Obj[]) ?? []).filter((e) => !newEdges.has(edgeKey(e))).map((e) => ({ ...e, label: MARK.removed + String(e.label ?? ""), style: "dashed" })),
  ];
  return { spec: { ...n, nodes, edges } as unknown as DiagramSpec, marks };
}

const FRAMES = ["alt", "par", "opt", "loop", "phase"];
const frameOf = (s: Obj) => FRAMES.find((k) => k in s);
const isMessage = (s: Obj) => typeof s.from === "string" && typeof s.to === "string";
function stepKey(s: Obj): string {
  if (isMessage(s)) return `msg:${s.from}>${s.to}:${words(String(s.label ?? ""))}`;
  if ("note" in s) return `note:${words(String(s.note))}`;
  const frame = frameOf(s);
  if (frame === "alt" || frame === "par") return `${frame}:${((s[frame] as Obj[]) ?? []).map((x) => words(String(x.when ?? ""))).join("|")}`;
  return `${frame}:${words(String(s[frame!] ?? ""))}`;
}

const prefix = (s: Obj, change: Change): Obj => {
  if (isMessage(s)) return { ...s, label: MARK[change] + String(s.label ?? "") };
  if ("note" in s) return { ...s, note: MARK[change] + String(s.note) };
  const frame = frameOf(s)!;
  if (frame === "alt" || frame === "par")
    return { ...s, [frame]: (s[frame] as Obj[]).map((x) => ({ ...x, when: MARK[change] + String(x.when ?? ""), steps: ((x.steps as Obj[]) ?? []).map((y) => prefix(y, change)) })) };
  return { ...s, [frame]: MARK[change] + String(s[frame] ?? ""), steps: ((s.steps as Obj[]) ?? []).map((y) => prefix(y, change)) };
};

/** Two frames of the same kind, merged: their sections paired in order, each section's steps unified. */
function unifyFrame(a: Obj, b: Obj): Obj {
  const frame = frameOf(b)!;
  if (frame === "alt" || frame === "par") {
    const was = (a[frame] as Obj[]) ?? [];
    const is = (b[frame] as Obj[]) ?? [];
    const sections = is.map((sec, i) => {
      const before = was[i];
      if (!before) return { ...sec, when: MARK.added + String(sec.when ?? ""), steps: ((sec.steps as Obj[]) ?? []).map((y) => prefix(y, "added")) };
      const when = words(String(before.when ?? "")) === words(String(sec.when ?? "")) ? sec.when : MARK.changed + String(sec.when ?? "");
      return { ...sec, when, steps: unifySteps((before.steps as Obj[]) ?? [], (sec.steps as Obj[]) ?? []) };
    });
    for (const sec of was.slice(is.length)) sections.push({ ...sec, when: MARK.removed + String(sec.when ?? ""), steps: ((sec.steps as Obj[]) ?? []).map((y) => prefix(y, "removed")) });
    return { ...b, [frame]: sections };
  }
  const label = words(String(a[frame] ?? "")) === words(String(b[frame] ?? "")) ? b[frame] : MARK.changed + String(b[frame] ?? "");
  return { ...b, [frame]: label, steps: unifySteps((a.steps as Obj[]) ?? [], (b.steps as Obj[]) ?? []) };
}

/** Like a line diff: steps both lists share stay; between them, a removed and an added step of the same kind (same arrow, or same frame) become one changed step. */
function unifySteps(was: Obj[], is: Obj[]): Obj[] {
  const [ka, kb] = [was.map(stepKey), is.map(stepKey)];
  const lcs = Array.from({ length: was.length + 1 }, () => new Array<number>(is.length + 1).fill(0));
  for (let i = was.length - 1; i >= 0; i--)
    for (let j = is.length - 1; j >= 0; j--) lcs[i][j] = ka[i] === kb[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: Obj[] = [];
  let [i, j] = [0, 0];
  // Between two shared steps: pair each removed step with a later added one of the same kind (a frame of
  // the same keyword, or an arrow between the same two), in order; the rest are plain removals and additions.
  const flush = (gone: Obj[], come: Obj[]) => {
    const kind = (x: Obj) => frameOf(x) ?? (isMessage(x) ? `${x.from}>${x.to}` : "note");
    const partner = new Map<number, number>();
    let from = 0;
    gone.forEach((g, gi) => {
      const ci = come.findIndex((c, k) => k >= from && kind(c) === kind(g));
      if (ci >= 0) {
        partner.set(ci, gi);
        from = ci + 1;
      }
    });
    let next = 0;
    come.forEach((b, ci) => {
      const gi = partner.get(ci);
      if (gi === undefined) return void out.push(prefix(b, "added"));
      for (; next < gi; next++) out.push(prefix(gone[next], "removed"));
      next = gi + 1;
      const a = gone[gi];
      out.push(frameOf(b) ? unifyFrame(a, b) : { ...b, label: MARK.changed + String(b.label ?? "") });
    });
    for (; next < gone.length; next++) out.push(prefix(gone[next], "removed"));
  };
  let gone: Obj[] = [];
  let come: Obj[] = [];
  while (i < was.length || j < is.length) {
    if (i < was.length && j < is.length && ka[i] === kb[j]) {
      flush(gone, come);
      [gone, come] = [[], []];
      out.push(frameOf(is[j]) ? unifyFrame(was[i], is[j]) : is[j]);
      i++;
      j++;
    } else if (j < is.length && (i >= was.length || lcs[i][j + 1] >= lcs[i + 1][j])) come.push(is[j++]);
    else gone.push(was[i++]);
  }
  flush(gone, come);
  return out;
}

const CHANGE_CSS = `
.dc-label { font: 600 12px/1.4 system-ui, sans-serif; text-transform: uppercase; letter-spacing: .04em; opacity: .7; margin: 12px 0 4px; }
.dc-added .cd-seq-line { stroke: #1a7f37 !important; stroke-width: 2px; }
.dc-added .cd-seq-label, .dc-added.cd-seq-frame-when { fill: #1a7f37 !important; font-weight: 700; }
.dc-removed .cd-seq-line { stroke: #cf222e !important; stroke-width: 2px; }
.dc-removed .cd-seq-label, .dc-removed.cd-seq-frame-when { fill: #cf222e !important; font-weight: 700; text-decoration: line-through; }
.react-flow__node.dc-added > * { outline: 3px solid #1a7f37; outline-offset: 2px; border-radius: 10px; }
.react-flow__node.dc-removed > * { outline: 3px solid #cf222e; outline-offset: 2px; border-radius: 10px; }
.dc-changed .cd-seq-line { stroke: #bf8700 !important; stroke-width: 2px; }
.dc-changed .cd-seq-label, .dc-changed.cd-seq-frame-when, .dc-changed .cd-seq-note-text { fill: #bf8700 !important; font-weight: 700; }
.dc-added .cd-seq-note-text { fill: #1a7f37 !important; font-weight: 700; }
.dc-removed .cd-seq-note-text { fill: #cf222e !important; font-weight: 700; }
.dc-removed .cd-seq-line { stroke-dasharray: 5 4; }
.react-flow__node.dc-changed > * { outline: 3px solid #bf8700; outline-offset: 2px; border-radius: 10px; }
.cd-dark .dc-added .cd-seq-line { stroke: #3fb950 !important; } .cd-dark .dc-added .cd-seq-label, .cd-dark .dc-added.cd-seq-frame-when { fill: #3fb950 !important; }
.cd-dark .dc-removed .cd-seq-line { stroke: #f85149 !important; } .cd-dark .dc-removed .cd-seq-label, .cd-dark .dc-removed.cd-seq-frame-when { fill: #f85149 !important; }
.cd-dark .dc-changed .cd-seq-line { stroke: #d29922 !important; } .cd-dark .dc-changed .cd-seq-label, .cd-dark .dc-changed.cd-seq-frame-when { fill: #d29922 !important; }
.dc-tabs { display: flex; align-items: center; gap: 4px; margin: 4px 0 8px; font: 13px/1.4 system-ui, sans-serif; }
.dc-tabs button { font: inherit; padding: 3px 12px; border: 1px solid #8c959f66; background: transparent; color: inherit; border-radius: 6px; cursor: pointer; }
.dc-tabs button.on { background: #0969da; border-color: #0969da; color: #fff; }
.dc-legend { margin-left: auto; display: flex; gap: 12px; font-weight: 600; }
.dc-l-added { color: #1a7f37; } .dc-l-removed { color: #cf222e; } .dc-l-changed { color: #bf8700; }
`;

const words = (t: string) => t.replace(/\s+/g, " ").trim();

/** The parts of a diagram a change can touch: each message ("msg:from>to:label"), frame label ("frame:…") and node ("node:id:definition"). */
function parts(spec: DiagramSpec): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (typeof o.from === "string" && typeof o.to === "string" && typeof o.label === "string" && !("nodes" in o)) out.add(`msg:${words(o.label)}`);
    for (const key of ["when", "opt", "loop"]) if (typeof o[key] === "string") out.add(`frame:${words(o[key] as string)}`);
    for (const value of Object.values(o)) walk(value);
  };
  const s = spec as unknown as Record<string, unknown>;
  if (Array.isArray(s.nodes)) for (const n of s.nodes as Record<string, unknown>[]) out.add(`node:${n.id}:${JSON.stringify(n)}`);
  walk(s.steps);
  return out;
}

/** Marks the drawn parts whose key is in `marks`, again whenever the diagram redraws. */
function Marked({ marks, tone, children }: { marks: Set<string>; tone: "added" | "removed" | "unified"; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = ref.current;
    if (!box || (!marks.size && tone !== "unified")) return;
    const nodes = new Set([...marks].filter((k) => k.startsWith("node:")).map((k) => k.split(":")[1]));
    const apply = () => {
      if (tone === "unified") {
        // The unified diagram carries its marks in the text: "+ ", "− ", "~ ".
        const change = (t: string) => (t.startsWith(MARK.added) ? "added" : t.startsWith(MARK.removed) ? "removed" : t.startsWith(MARK.changed) ? "changed" : null);
        const set = (el: Element, c: string | null) => (["added", "removed", "changed"] as const).forEach((k) => el.classList.toggle(`dc-${k}`, c === k));
        for (const g of box.querySelectorAll(".cd-seq-msg")) set(g, change(g.querySelector(".cd-seq-label")?.textContent ?? ""));
        for (const g of box.querySelectorAll(".cd-seq-note")) set(g, change(g.querySelector(".cd-seq-note-text")?.textContent ?? ""));
        for (const t of box.querySelectorAll(".cd-seq-frame-when")) set(t, change((t.textContent ?? "").replace(/^\[/, "")));
        for (const n of box.querySelectorAll<HTMLElement>(".react-flow__node")) {
          const id = n.dataset.id ?? "";
          set(n, (["added", "removed", "changed"] as const).find((k) => marks.has(`node:${k}:${id}`)) ?? null);
        }
        return;
      }
      for (const g of box.querySelectorAll<SVGGElement>(".cd-seq-msg")) {
        const label = words([...g.querySelectorAll(".cd-seq-label")].map((t) => t.textContent ?? "").join(" "));
        g.classList.toggle(`dc-${tone}`, marks.has(`msg:${label}`));
      }
      for (const t of box.querySelectorAll<SVGTextElement>(".cd-seq-frame-when")) {
        t.classList.toggle(`dc-${tone}`, marks.has(`frame:${words((t.textContent ?? "").replace(/^\[|\]$/g, ""))}`));
      }
      for (const n of box.querySelectorAll<HTMLElement>(".react-flow__node")) n.classList.toggle(`dc-${tone}`, nodes.has(n.dataset.id ?? ""));
    };
    let frame = 0;
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(apply);
    });
    observer.observe(box, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    apply();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [marks, tone]);
  return <div ref={ref}>{children}</div>;
}

export function unmountDiagram(host: HTMLElement) {
  roots.get(host)?.unmount();
  roots.delete(host);
}

/** Open the guide page of a doc a diagram node links to (relative to the diagram's file). */
function follow(link: string, file: string | null) {
  const [target, hash] = link.split("#");
  const base = file ? file.split("/").slice(0, -1) : [];
  for (const part of target.split("/")) {
    if (part === "..") base.pop();
    else if (part !== ".") base.push(part);
  }
  const page = (docPages as Record<string, string>)[base.join("/")];
  if (page) window.location.href = `${page}${hash ? `#${hash}` : ""}`;
}

function Themed({ spec, onLink }: { spec: DiagramSpec; onLink: (link: string) => void }) {
  const current = (): "light" | "dark" => {
    const chosen = document.documentElement.dataset.theme;
    if (chosen === "light" || chosen === "dark") return chosen;
    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  };
  const [theme, setTheme] = useState(current);
  useEffect(() => {
    const update = () => setTheme(current());
    const media = matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", update);
    const onChange = (e: Event) => (e as CustomEvent<string>).detail === "theme" && queueMicrotask(update);
    store.addEventListener("change", onChange);
    return () => {
      media.removeEventListener("change", update);
      store.removeEventListener("change", onChange);
    };
  }, []);
  return <Diagram spec={spec} theme={theme} onLink={onLink} />;
}
