// <seq-flow>: a sequence diagram for a flow from the model (flow="id") or an
// inline <script type="application/yaml"> flow. Steps marked `change:
// added|removed|changed` get Before / After / Diff tabs; variant="…" picks
// the initial one.

import { type Flow, type FlowStep, model, pageModel, parseInlineYaml, refs } from "./data";
import { openSource } from "./source";
import { arrowDefs, measure, svgEl, text } from "./graph";
import { attachPanZoom } from "./panzoom";

const LABEL_FONT = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
const NAME_FONT = "12px ui-monospace, SFMono-Regular, Menlo, monospace";
const ROW = 30;
const TOP = 64;
const LANE_MIN = 170;

type Variant = "diff" | "before" | "after";

interface Op {
  draw: (svg: SVGSVGElement) => void;
}

export class SeqFlow extends HTMLElement {
  private flow!: Flow;

  connectedCallback() {
    if (this.dataset.rendered) return;
    this.dataset.rendered = "1";
    const id = this.getAttribute("flow");
    const inline = parseInlineYaml<Flow>(this);
    const flow = inline ?? (id ? model.flows.get(id) : undefined);
    if (!flow) throw new Error(`seq-flow: unknown flow ${id}`);
    this.flow = flow;
    const hasChanges = flow.steps.some((s) => s.change);
    this.renderVariant((this.getAttribute("variant") as Variant) ?? (hasChanges ? "diff" : "after"), hasChanges);
  }

  private renderVariant(variant: Variant, hasChanges: boolean) {
    const frame = document.createElement("div");
    frame.className = "seq-frame";
    if (hasChanges) frame.append(this.tabs(variant));
    const svg = renderFlow(this.flow, variant);
    frame.append(svg);
    const caption = this.getAttribute("caption") ?? this.flow.title;
    this.replaceChildren(frame);
    fitSeq(frame, svg);
    attachPanZoom(frame, svg);
    this.dispatchEvent(new Event("diagram:rendered", { bubbles: true }));
    if (caption) {
      const c = document.createElement("div");
      c.className = "caption";
      c.textContent = caption;
      this.append(c);
    }
  }

  private tabs(active: Variant): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "seq-tabs";
    for (const v of ["before", "after", "diff"] as Variant[]) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = v === "diff" ? "Diff" : v === "before" ? "Before" : "After";
      b.className = v === active ? "active" : "";
      b.addEventListener("click", () => this.renderVariant(v, true));
      bar.append(b);
    }
    return bar;
  }
}

// Helpers

/** Scale down to the frame width, but not below MIN_SCALE (the frame scrolls instead). */
function fitSeq(frame: HTMLElement, svg: SVGSVGElement) {
  const MIN_SCALE = 0.62;
  const width = Number(svg.getAttribute("width"));
  const height = Number(svg.getAttribute("height"));
  const scale = Math.min(1, Math.max(MIN_SCALE, (frame.clientWidth - 22) / width));
  svg.setAttribute("width", String(Math.round(width * scale)));
  svg.setAttribute("height", String(Math.round(height * scale)));
}

function renderFlow(flow: Flow, variant: Variant): SVGSVGElement {
  const steps = flow.steps.filter(
    (s) => !(variant === "before" && s.change === "added") && !(variant === "after" && s.change === "removed"),
  );
  const lanes = flow.participants;
  const laneIndex = new Map(lanes.map((p, i) => [p, i]));
  const headers = lanes.map((p) => participantLabel(p));

  const gaps = lanes.slice(1).map((_, i) => {
    let need = LANE_MIN;
    for (const s of steps) {
      if (!s.from || !s.to || !s.label) continue;
      const a = laneIndex.get(s.from)!;
      const b = laneIndex.get(s.to)!;
      if (Math.min(a, b) === i && Math.max(a, b) === i + 1) need = Math.max(need, measure(displayLabel(s, variant), LABEL_FONT) + 56);
    }
    const headerNeed = (headerWidth(headers[i]) + headerWidth(headers[i + 1])) / 2 + 24;
    return Math.max(need, headerNeed);
  });
  const x: number[] = [];
  // Room on the left for block tags and notes that extend past the first lane.
  let cursor = Math.max(headerWidth(headers[0]) / 2 + 12, 96);
  lanes.forEach((_, i) => {
    x.push(cursor);
    if (i < gaps.length) cursor += gaps[i];
  });
  let right = cursor + headerWidth(headers.at(-1)!) / 2 + 12;
  const extend = (xRight: number) => (right = Math.max(right, xRight + 12));

  const ops: Op[] = [];
  const blocks: { kind: string; label: string; y: number; min: number; max: number; elses: { y: number; label: string }[] }[] = [];
  let y = TOP;
  let number = 0;
  const cover = (a: number, b: number) => blocks.forEach((bl) => ((bl.min = Math.min(bl.min, a)), (bl.max = Math.max(bl.max, b))));

  for (const s of steps) {
    const blockKind = (["loop", "alt", "opt", "par"] as const).find((k) => s[k] !== undefined);
    if (blockKind) {
      blocks.push({ kind: blockKind, label: String(s[blockKind]), y, min: Infinity, max: -Infinity, elses: [] });
      y += 26;
      continue;
    }
    if (s.else !== undefined) {
      blocks.at(-1)?.elses.push({ y, label: String(s.else) });
      y += 22;
      continue;
    }
    if (s.end) {
      const bl = blocks.pop();
      if (bl) {
        const x1 = (Number.isFinite(bl.min) ? x[bl.min] : x[0]) - 70;
        const x2 = (Number.isFinite(bl.max) ? x[bl.max] : x[0]) + 70;
        extend(Math.max(x2, x1 + measure(`${bl.kind}  [${bl.label}]`, LABEL_FONT) + 30));
        const y2 = y + 4;
        ops.push({
          draw: (svg) => {
            const g = svgEl("g", { class: `block block-${bl.kind}` });
            g.append(svgEl("rect", { x: x1, y: bl.y, width: x2 - x1, height: y2 - bl.y, rx: 4 }));
            const tag = `${bl.kind}`;
            const tagW = measure(tag, LABEL_FONT) + 12;
            g.append(svgEl("path", { d: `M ${x1} ${bl.y + 18} H ${x1 + tagW} L ${x1 + tagW + 6} ${bl.y + 12} V ${bl.y}`, class: "block-tag" }));
            g.append(text(x1 + 6, bl.y + 13, tag, "block-kind"));
            g.append(text(x1 + tagW + 14, bl.y + 13, `[${bl.label}]`, "block-label"));
            for (const e of bl.elses) {
              g.append(svgEl("line", { x1, x2, y1: e.y, y2: e.y, class: "block-else" }));
              g.append(text(x1 + 8, e.y + 14, `[${e.label}]`, "block-label"));
            }
            svg.insertBefore(g, svg.querySelector(".lifelines")!.nextSibling);
          },
        });
      }
      y += 14;
      continue;
    }
    if (s.note !== undefined) {
      const over = (s.over ?? [s.from ?? lanes[0]]).map((p) => laneIndex.get(p)!);
      const a = Math.min(...over);
      const b = Math.max(...over);
      cover(a, b);
      const lines = wrap(String(s.note), 64);
      const h = 10 + lines.length * 15;
      const w = Math.max(measure(lines.reduce((l, c) => (c.length > l.length ? c : l), ""), LABEL_FONT) + 20, x[b] - x[a] + 60);
      const cx = (x[a] + x[b]) / 2;
      extend(cx + w / 2);
      const top = y;
      ops.push({
        draw: (svg) => {
          const g = svgEl("g", { class: `note ${changeClass(s, variant)}` });
          g.append(svgEl("rect", { x: cx - w / 2, y: top, width: w, height: h, rx: 3 }));
          lines.forEach((line, i) => g.append(text(cx - w / 2 + 10, top + 16 + i * 15, line, "note-text")));
          svg.append(g);
        },
      });
      y += h + 10;
      continue;
    }
    if (!s.from || !s.to) continue;
    const a = laneIndex.get(s.from);
    const b = laneIndex.get(s.to);
    if (a === undefined || b === undefined) throw new Error(`seq-flow ${flow.id}: unknown participant in step "${s.label}"`);
    cover(Math.min(a, b), Math.max(a, b));
    number += 1;
    const n = number;
    const rowY = y + 18;
    const label = stepLabel(s, variant);
    const labelWidth = measure(displayLabel(s, variant), LABEL_FONT);
    extend(a === b ? x[a] + 42 + labelWidth : (x[a] + x[b]) / 2 + labelWidth / 2);
    const problem = s.problem && variant !== "after" ? `⚠ ${s.problem}` : null;
    // Under the arrow, centered on it (or under the label of a self-call).
    const problemWidth = problem ? measure(problem, LABEL_FONT) : 0;
    const problemX = a === b ? x[a] + 42 : (x[a] + x[b]) / 2 - problemWidth / 2;
    if (problem) extend(problemX + problemWidth + 10);
    ops.push({
      draw: (svg) => {
        const cls = ["msg", `mkind-${s.kind ?? "call"}`, changeClass(s, variant)].join(" ");
        const g = svgEl("g", { class: cls });
        const marker = `url(#arrow-${(variant === "diff" && s.change) || "base"})`;
        if (a === b) {
          const x0 = x[a];
          g.append(svgEl("path", { d: `M ${x0} ${rowY - 6} h 34 v 14 h -32`, "marker-end": marker }));
          g.append(labelText(x0 + 42, rowY + 2, s, variant, label));
        } else {
          const x1 = x[a] + (b > a ? 4 : -4);
          const x2 = x[b] + (b > a ? -4 : 4);
          g.append(svgEl("line", { x1, x2, y1: rowY, y2: rowY, "marker-end": marker }));
          const mid = (x[a] + x[b]) / 2 - labelWidth / 2;
          g.append(labelText(mid, rowY - 6, s, variant, label));
        }
        if (problem) {
          g.classList.add("problem");
          g.append(text(problemX, rowY + (a === b ? 26 : 16), problem, "problem-text"));
        }
        g.append(svgEl("circle", { cx: x[a] + (a === b ? 0 : b > a ? -14 : 14), cy: rowY, r: 7, class: "step-no" }));
        g.append(text(x[a] + (a === b ? 0 : b > a ? -14 : 14), rowY + 3.5, String(n), "step-no-text"));
        svg.append(g);
      },
    });
    y += ROW + (problem ? 14 : 0);
  }
  const height = y + 16;
  const width = right;

  const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, class: "seq-svg", width, height });
  svg.append(arrowDefs());
  const lifelines = svgEl("g", { class: "lifelines" });
  lanes.forEach((p, i) => {
    lifelines.append(svgEl("line", { x1: x[i], x2: x[i], y1: 44, y2: height - 6, class: "lifeline" }));
  });
  svg.append(lifelines);
  lanes.forEach((p, i) => {
    const h = headers[i];
    const w = headerWidth(h);
    const g = svgEl("g", { class: `participant kind-${h.styleKind}` });
    g.append(svgEl("rect", { x: x[i] - w / 2, y: 4, width: w, height: 40, rx: 5 }));
    // Plain participants ("actor:cashier") show just their name.
    if (h.kind === "actor") g.append(text(x[i] - w / 2 + 8, 28, h.name, "name"));
    else {
      g.append(text(x[i] - w / 2 + 8, 18, h.kind, "kind"));
      g.append(text(x[i] - w / 2 + 8, 35, h.name, "name"));
    }
    g.append(svgEl("title", {}, h.tip));
    if (h.code && refs[h.code]?.ok) {
      g.classList.add("linked");
      g.addEventListener("click", () => void openSource(h.code!));
    }
    svg.append(g);
  });
  ops.forEach((op) => op.draw(svg));
  return svg;
}

function stepLabel(s: FlowStep, variant: Variant): string {
  if (s.change === "changed" && variant === "before" && s.was) return String(s.was);
  return String(s.label ?? "");
}

/** The text actually drawn for a step (diff view shows "was → label"). */
function displayLabel(s: FlowStep, variant: Variant): string {
  if (s.change === "changed" && variant === "diff" && s.was) return `${s.was}  →  ${stepLabel(s, variant)}`;
  return stepLabel(s, variant);
}

function labelText(x0: number, y0: number, s: FlowStep, variant: Variant, label: string): SVGElement {
  const t = svgEl("text", { x: x0, y: y0, class: "msg-label" });
  if (s.change === "changed" && variant === "diff" && s.was) {
    const old = svgEl("tspan", { class: "was" }, String(s.was));
    t.append(old, svgEl("tspan", {}, "  →  "), svgEl("tspan", {}, label));
  } else {
    t.textContent = label;
  }
  if (s.code && refs[s.code]?.ok) {
    t.classList.add("linked");
    t.addEventListener("click", () => void openSource(s.code!));
    const ref = refs[s.code!];
    t.append(svgEl("title", {}, `${ref.file}:${ref.line}`));
  }
  return t;
}

/** Only the Diff tab marks steps: Before and After show each version as it was (or is). */
function changeClass(s: FlowStep, variant: Variant): string {
  return s.change && variant === "diff" ? `mark-${s.change}` : "";
}

const KNOWN_KINDS = new Set(["system", "external", "crate", "module", "fn", "type", "trait", "table", "channel", "process", "state", "ui", "config", "actor"]);

function participantLabel(id: string) {
  const el = pageModel().elements.get(id) ?? model.elements.get(id);
  const [kind, name] = el ? [el.kind, el.name] : id.includes(":") ? id.split(":", 2) : ["actor", id];
  const styleKind = KNOWN_KINDS.has(kind) ? kind : "external";
  return { kind, styleKind, name, code: el?.code, tip: el?.description ? `${name}\n\n${el.description}` : name };
}

function headerWidth(h: { kind: string; name: string }): number {
  return Math.max(measure(h.name, NAME_FONT), measure(h.kind, LABEL_FONT)) + 18;
}

function wrap(s: string, max: number): string[] {
  const out: string[] = [];
  for (const para of s.split("\n")) {
    let line = "";
    for (const word of para.split(" ")) {
      if ((line + " " + word).trim().length > max) {
        out.push(line.trim());
        line = word;
      } else line += " " + word;
    }
    out.push(line.trim());
  }
  return out;
}
