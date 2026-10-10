// <sys-graph>: renders a slice of the system model as a layered diagram.
//
// Which elements are shown (one of):
//   view="id"                   a view from the model
//   elements="a, b, c"          explicit list
//   focus="a" depth="1"         a and its callers/callees (depth hops)
// Plus: expand="ids" shows the children of those elements inside them,
// changed/added/removed="ids" mark elements (or `from->to` relations),
// context="ids" marks elements that matter here but didn't change,
// relations="local" uses only the inline overlay's relations,
// direction="RIGHT|DOWN", layout='{"elk.option": "value"}' for fine control.
// An inline <script type="application/yaml"> may add page-local elements and
// relations (e.g. functions a branch introduces) with the same schema as the model.

import ELK, { type ElkNode } from "elkjs/lib/elk-api.js";
import elkWorkerUrl from "elkjs/lib/elk-worker.min.js?url";
import {
  type Model,
  type ModelElement,
  type ModelRelation,
  ancestors,
  childrenOf,
  coarsePointer,
  parseInlineYaml,
  refs,
  splitIds,
  withOverlay,
} from "./data";
import { attachPanZoom } from "./panzoom";
import { openSource } from "./source";

// Layout runs in a worker so the page stays responsive while graphs render.
const elk = new ELK({ workerUrl: elkWorkerUrl });
const FONT = "12px ui-monospace, SFMono-Regular, Menlo, monospace";
const KIND_FONT = "10px system-ui, sans-serif";

type Mark = "changed" | "added" | "removed" | "context";

interface Overlay {
  elements?: ModelElement[];
  relations?: ModelRelation[];
}

interface LaidOutNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  children?: LaidOutNode[];
}

interface LaidOutEdge {
  id: string;
  sections?: { startPoint: Point; endPoint: Point; bendPoints?: Point[] }[];
  labels?: { text: string; x: number; y: number; width: number; height: number }[];
}

interface Point {
  x: number;
  y: number;
}

interface VisibleEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
  kind?: string;
  exact: boolean;
}

export class SysGraph extends HTMLElement {
  async connectedCallback() {
    if (this.dataset.rendered) return;
    this.dataset.rendered = "1";
    const m = withOverlay(parseInlineYaml<Overlay>(this), this.getAttribute("relations") === "local");
    const marks = this.readMarks();
    const shown = this.shownElements(m, marks);
    const edges = visibleEdges(m, shown);
    const graph = buildElkGraph(m, shown, edges, this.layoutOptions());
    const layout = await elk.layout(graph as unknown as ElkNode);
    this.render(m, shown, edges, layout as unknown as LaidOutNode & { edges: LaidOutEdge[] }, marks);
  }

  private readMarks(): Map<string, Mark> {
    const marks = new Map<string, Mark>();
    for (const mark of ["context", "changed", "added", "removed"] as Mark[]) {
      for (const id of splitIds(this.getAttribute(mark))) marks.set(id, mark);
    }
    return marks;
  }

  private shownElements(m: Model, marks: Map<string, Mark>): Set<string> {
    const shown = new Set<string>();
    const view = this.getAttribute("view");
    const expand = new Set(splitIds(this.getAttribute("expand")));
    if (view) {
      const v = m.views.get(view);
      if (!v) throw new Error(`unknown view ${view}`);
      v.include.forEach((id) => shown.add(id));
      v.expand?.forEach((id) => expand.add(id));
      if (!this.hasAttribute("direction") && v.direction) this.setAttribute("direction", v.direction);
      if (!this.hasAttribute("layout") && v.layout) this.setAttribute("layout", JSON.stringify(v.layout));
    }
    splitIds(this.getAttribute("elements")).forEach((id) => shown.add(id));
    const focus = splitIds(this.getAttribute("focus"));
    if (focus.length) {
      const depth = Number(this.getAttribute("depth") ?? 1);
      let frontier = new Set(focus);
      focus.forEach((id) => shown.add(id));
      for (let hop = 0; hop < depth; hop++) {
        const next = new Set<string>();
        for (const r of m.relations) {
          if (frontier.has(r.from) && !shown.has(r.to)) next.add(r.to);
          if (frontier.has(r.to) && !shown.has(r.from)) next.add(r.from);
        }
        next.forEach((id) => shown.add(id));
        frontier = next;
      }
    }
    for (const id of marks.keys()) if (!id.includes("->")) shown.add(id);
    const expandInto = (id: string) => {
      for (const child of childrenOf(m, id)) {
        shown.add(child.id);
        if (expand.has(child.id)) expandInto(child.id);
      }
    };
    expand.forEach((id) => {
      shown.add(id);
      expandInto(id);
    });
    if (focus.length || this.hasAttribute("group")) {
      const stop = this.getAttribute("group") === "none" ? 0 : Infinity;
      for (const id of [...shown]) ancestors(m, id).slice(0, stop).forEach((a) => shown.add(a));
    }
    for (const id of shown) {
      if (!m.elements.has(id)) {
        console.warn(`sys-graph: unknown element ${id}`);
        shown.delete(id);
      }
    }
    return shown;
  }

  private layoutOptions(): Record<string, string> {
    const extra = this.getAttribute("layout");
    return {
      "elk.direction": this.getAttribute("direction") ?? "RIGHT",
      ...(extra ? (JSON.parse(extra) as Record<string, string>) : {}),
    };
  }

  private render(
    m: Model,
    shown: Set<string>,
    edges: VisibleEdge[],
    layout: LaidOutNode & { edges: LaidOutEdge[] },
    marks: Map<string, Mark>,
  ) {
    const pad = 8;
    const svg = svgEl("svg", {
      viewBox: `${-pad} ${-pad} ${layout.width + 2 * pad} ${layout.height + 2 * pad}`,
      class: "sys-graph-svg",
      role: "img",
    });
    svg.append(arrowDefs());
    const hasMarks = marks.size > 0;
    const containsMark = new Set<string>();
    for (const [id, mark] of marks) {
      if (id.includes("->") || mark === "context") continue;
      for (const a of ancestors(m, id)) containsMark.add(a);
    }

    const info = document.createElement("div");
    info.className = "node-info";
    info.hidden = true;
    const groupLayer = svgEl("g", {});
    const leafLayer = svgEl("g", {});
    const edgeLayer = svgEl("g", {});
    const drawNode = (n: LaidOutNode) => {
      const el = m.elements.get(n.id)!;
      const isGroup = !!n.children?.length;
      const mark = marks.get(n.id);
      const classes = ["node", `kind-${el.kind}`, isGroup ? "group" : "leaf"];
      if (mark) classes.push(`mark-${mark}`);
      else if (hasMarks && !isGroup) classes.push("dim");
      if (isGroup && containsMark.has(n.id)) classes.push("contains-mark");
      const g = svgEl("g", { class: classes.join(" "), "data-id": n.id });
      g.append(
        svgEl("rect", { x: n.x, y: n.y, width: n.width, height: n.height, rx: el.kind === "state" ? n.height / 2 : 6 }),
      );
      if (isGroup) {
        g.append(text(n.x + 10, n.y + 16, `${kindLabel(el)}  `, "kind"));
        const kindWidth = measure(`${kindLabel(el)}  `, KIND_FONT);
        g.append(text(n.x + 10 + kindWidth, n.y + 16, el.name, "name"));
      } else if (el.kind === "state") {
        g.append(text(n.x + n.width / 2, n.y + n.height / 2 + 4, el.name, "name centered"));
      } else {
        g.append(text(n.x + 10, n.y + 15, kindLabel(el), "kind"));
        g.append(text(n.x + 10, n.y + 32, el.name, "name"));
      }
      g.append(svgEl("title", {}, tooltip(el)));
      const hasCode = !!el.code && !!refs[el.code]?.ok;
      if (coarsePointer) {
        // No hover on touch: a tap shows what the box is, with a link to its code.
        g.classList.add("linked");
        g.addEventListener("click", (e) => {
          e.stopPropagation();
          showInfo(info, el);
        });
      } else if (hasCode) {
        g.classList.add("linked");
        g.addEventListener("click", (e) => {
          e.stopPropagation();
          void openSource(el.code!);
        });
      }
      g.addEventListener("mouseenter", () => focusEdges(svg, n.id, true));
      g.addEventListener("mouseleave", () => focusEdges(svg, n.id, false));
      (isGroup ? groupLayer : leafLayer).append(g);
      n.children?.forEach(drawNode);
    };
    layout.children?.forEach(drawNode);

    for (const e of layout.edges ?? []) {
      const info = edges.find((v) => v.id === e.id)!;
      const edgeMark = marks.get(`${info.from}->${info.to}`) ?? edgeMarkFromNodes(info, marks);
      const mark = edgeMark === "context" ? undefined : edgeMark;
      const classes = ["edge", `ekind-${info.kind ?? "call"}`, info.exact ? "exact" : "lifted"];
      if (mark) classes.push(`mark-${mark}`);
      else if (hasMarks) classes.push("dim");
      const g = svgEl("g", { class: classes.join(" "), "data-from": info.from, "data-to": info.to });
      for (const s of e.sections ?? []) {
        const pts = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint];
        g.append(
          svgEl("path", {
            d: roundedPath(pts, 6),
            "marker-end": `url(#arrow-${mark ?? "base"})`,
          }),
        );
      }
      for (const l of e.labels ?? []) {
        g.append(svgEl("rect", { x: l.x - 2, y: l.y - 1, width: l.width + 4, height: l.height + 2, class: "label-bg", rx: 3 }));
        g.append(text(l.x, l.y + l.height - 4, l.text, "edge-label"));
      }
      edgeLayer.append(g);
    }
    svg.append(groupLayer, edgeLayer, leafLayer);

    const frame = document.createElement("div");
    frame.className = "graph-frame";
    frame.append(svg, info);
    svg.addEventListener("click", () => (info.hidden = true));
    const caption = this.getAttribute("caption");
    this.replaceChildren(frame);
    fitWidth(frame, svg, layout.width + 2 * pad, layout.height + 2 * pad);
    attachPanZoom(frame, svg);
    if (caption) {
      const c = document.createElement("div");
      c.className = "caption";
      c.textContent = caption;
      this.append(c);
    }
    this.append(legend(m, shown, marks, containsMark.size > 0));
    this.classList.add("ready");
    this.dispatchEvent(new Event("diagram:rendered", { bubbles: true }));
  }
}

// Helpers

function showInfo(info: HTMLElement, el: ModelElement) {
  const ref = el.code ? refs[el.code] : undefined;
  const where = ref ? `${ref.file}${ref.line ? `:${ref.line}` : ""}` : "";
  info.innerHTML = `<div class="kind">${escapeText(el.kind)}</div><div class="name">${escapeText(el.name)}</div>${
    el.description ? `<div class="desc">${escapeText(el.description)}</div>` : ""
  }${where ? `<a href="#" class="code-ref" data-ref="${escapeText(el.code!)}">${escapeText(where)}</a>` : ""}`;
  info.hidden = false;
}

function escapeText(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/** Natural size, scaled down to the frame width but never below MIN_SCALE (scroll instead). */
function fitWidth(frame: HTMLElement, svg: SVGSVGElement, width: number, height: number) {
  const MIN_SCALE = 0.55;
  const available = frame.clientWidth - 22;
  const scale = Math.min(1, Math.max(MIN_SCALE, available / width));
  svg.setAttribute("width", String(Math.round(width * scale)));
  svg.setAttribute("height", String(Math.round(height * scale)));
  frame.classList.toggle("overflowing", width * scale > available + 1);
}

function visibleEdges(m: Model, shown: Set<string>): VisibleEdge[] {
  // Shown elements that contain other shown elements are drawn as containers;
  // edges to containers are summaries of their contents and only add noise.
  const containers = new Set<string>();
  for (const id of shown) for (const a of ancestors(m, id)) if (shown.has(a)) containers.add(a);
  const liftTo = (id: string): string | null => {
    if (shown.has(id)) return id;
    return ancestors(m, id).find((a) => shown.has(a)) ?? null;
  };
  const byKey = new Map<string, VisibleEdge>();
  for (const r of m.relations) {
    const from = liftTo(r.from);
    const to = liftTo(r.to);
    if (!from || !to || from === to) continue;
    if (ancestors(m, from).includes(to) || ancestors(m, to).includes(from)) continue;
    const exact = from === r.from && to === r.to;
    // Edges between two containers summarize their contents; lifted edges into a
    // container do too. An exact relation between a box and a container stays.
    const fromBox = containers.has(from);
    const toBox = containers.has(to);
    if ((fromBox && toBox) || ((fromBox || toBox) && !exact)) continue;
    const key = `${from}->${to}`;
    const existing = byKey.get(key);
    if (existing) {
      if (exact && !existing.exact) Object.assign(existing, { label: r.label, kind: r.kind, exact });
      continue;
    }
    byKey.set(key, { id: `e${byKey.size}`, from, to, label: exact ? r.label : undefined, kind: r.kind, exact });
  }
  return [...byKey.values()];
}

function buildElkGraph(m: Model, shown: Set<string>, edges: VisibleEdge[], options: Record<string, string>) {
  const parentOf = (id: string) => ancestors(m, id).find((a) => shown.has(a)) ?? null;
  const nodes = new Map<string, Record<string, unknown>>();
  const order = [...shown];
  for (const id of order) {
    const el = m.elements.get(id)!;
    const isState = el.kind === "state";
    const nameWidth = measure(el.name, FONT);
    const kindWidth = measure(kindLabel(el), KIND_FONT);
    nodes.set(id, {
      id,
      width: Math.max(isState ? nameWidth + 32 : Math.max(nameWidth, kindWidth) + 22, 64),
      height: isState ? 30 : 42,
      children: [],
      layoutOptions: {
        "elk.padding": "[top=30,left=14,bottom=14,right=14]",
        "elk.nodeSize.constraints": "MINIMUM_SIZE",
        "elk.nodeSize.minimum": "(120, 40)",
      },
    });
  }
  const roots: Record<string, unknown>[] = [];
  for (const id of order) {
    const parent = parentOf(id);
    const node = nodes.get(id)!;
    if (parent) (nodes.get(parent)!.children as unknown[]).push(node);
    else roots.push(node);
  }
  for (const node of nodes.values()) {
    if ((node.children as unknown[]).length) {
      delete node.width;
      delete node.height;
    } else {
      delete node.layoutOptions;
    }
  }
  const flat = roots.every((n) => !(n.children as unknown[]).length);
  const algorithm = edges.length === 0 && flat ? "rectpacking" : "layered";
  return {
    id: "root",
    layoutOptions: {
      "elk.algorithm": algorithm,
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.json.edgeCoords": "ROOT",
      "elk.json.shapeCoords": "ROOT",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.layered.spacing.nodeNodeBetweenLayers": "56",
      "elk.spacing.nodeNode": "22",
      "elk.spacing.edgeNode": "14",
      "elk.spacing.edgeEdge": "10",
      "elk.spacing.edgeLabel": "4",
      "elk.edgeLabels.placement": "CENTER",
      ...options,
    },
    children: roots,
    edges: edges.map((e) => ({
      id: e.id,
      sources: [e.from],
      targets: [e.to],
      labels: e.label ? [{ text: String(e.label), width: measure(String(e.label), KIND_FONT) + 2, height: 14 }] : [],
    })),
  };
}

function edgeMarkFromNodes(e: VisibleEdge, marks: Map<string, Mark>): Mark | undefined {
  const a = marks.get(e.from);
  const b = marks.get(e.to);
  if (a === "added" || b === "added") return e.exact ? "added" : undefined;
  if (a === "removed" || b === "removed") return e.exact ? "removed" : undefined;
  return undefined;
}

function focusEdges(svg: SVGSVGElement, id: string, on: boolean) {
  svg.classList.toggle("hovering", on);
  svg.querySelectorAll<SVGGElement>(".edge").forEach((g) => {
    const hit = g.dataset.from === id || g.dataset.to === id;
    g.classList.toggle("hot", on && hit);
  });
}

/** Change marks stay visible; element kinds and usage hints are behind "?". */
function legend(m: Model, shown: Set<string>, marks: Map<string, Mark>, containsMark: boolean): DocumentFragment {
  const present = new Set(marks.values());
  const markChips = (["added", "changed", "removed", "context"] as Mark[])
    .filter((mark) => present.has(mark))
    .map((mark) => `<span class="chip mark-${mark}">${mark}</span>`);
  if (containsMark) markChips.push('<span class="chip contains-mark">contains changes</span>');
  const kinds = new Set([...shown].map((id) => m.elements.get(id)!.kind));
  const help = [...kinds].map((kind) => `<span class="chip kind-${kind}">${kind}</span>`);
  help.push(
    coarsePointer
      ? '<span class="hint">tap a box for details · pinch to zoom · double-tap to reset</span>'
      : '<span class="hint">hover: connections · click: open in editor · ctrl+wheel / buttons: zoom</span>',
  );
  const fragment = document.createDocumentFragment();
  if (markChips.length) {
    const marksDiv = document.createElement("div");
    marksDiv.className = "legend-marks";
    marksDiv.innerHTML = markChips.join("");
    fragment.append(marksDiv);
  }
  const helpDiv = document.createElement("div");
  helpDiv.className = "legend";
  helpDiv.innerHTML = help.join("");
  fragment.append(helpDiv);
  return fragment;
}

function tooltip(el: ModelElement): string {
  const ref = el.code ? refs[el.code] : undefined;
  const where = ref ? `\n${ref.file}${ref.line ? `:${ref.line}` : ""}${ref.ok ? "" : " (stale reference)"}` : "";
  return `${el.name} (${el.kind})${el.description ? `\n\n${el.description}` : ""}${where}`;
}

function kindLabel(el: ModelElement): string {
  return el.kind === "fn" ? "fn" : el.kind;
}

let canvas: CanvasRenderingContext2D | null = null;
export function measure(s: string, font: string): number {
  canvas ??= document.createElement("canvas").getContext("2d");
  canvas!.font = font;
  return Math.ceil(canvas!.measureText(s).width);
}

export function svgEl(tag: string, attrs: Record<string, string | number>, content?: string): SVGElement & SVGSVGElement {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag) as SVGElement & SVGSVGElement;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  if (content !== undefined) el.textContent = content;
  return el;
}

export function text(x: number, y: number, content: string, cls: string): SVGElement {
  return svgEl("text", { x, y, class: cls }, content);
}

export function arrowDefs(): SVGElement {
  const defs = svgEl("defs", {});
  for (const name of ["base", "added", "changed", "removed", "hot"]) {
    const marker = svgEl("marker", {
      id: `arrow-${name}`,
      viewBox: "0 0 10 10",
      refX: 9,
      refY: 5,
      markerWidth: 7,
      markerHeight: 7,
      orient: "auto-start-reverse",
      class: `arrow arrow-${name}`,
    });
    marker.append(svgEl("path", { d: "M 0 0 L 10 5 L 0 10 z" }));
    defs.append(marker);
  }
  return defs;
}

function roundedPath(pts: Point[], r: number): string {
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [a, b, c] = [pts[i - 1], pts[i], pts[i + 1]];
    const d1 = Math.min(r, Math.hypot(b.x - a.x, b.y - a.y) / 2);
    const d2 = Math.min(r, Math.hypot(c.x - b.x, c.y - b.y) / 2);
    const p1 = towards(b, a, d1);
    const p2 = towards(b, c, d2);
    d += ` L ${p1.x} ${p1.y} Q ${b.x} ${b.y} ${p2.x} ${p2.y}`;
  }
  const last = pts[pts.length - 1];
  return `${d} L ${last.x} ${last.y}`;
}

function towards(from: Point, to: Point, dist: number): Point {
  const len = Math.hypot(to.x - from.x, to.y - from.y) || 1;
  return { x: from.x + ((to.x - from.x) / len) * dist, y: from.y + ((to.y - from.y) / len) * dist };
}
