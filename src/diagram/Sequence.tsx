// Sequence diagrams: participants across the top, messages between them
// going down, and frames for what branches (alt), may happen (opt), repeats
// (loop) or runs at the same time (par). A phase is a tinted band with a name.
//
//   type: sequence
//   participants:
//     - { id: api, is: API }
//     - { id: db, is: DB }
//   steps:
//     - { from: api, to: db, label: is it in stock? }
//     - { from: db, to: api, label: "yes", kind: return }
//     - alt:
//         - { when: paid, steps: [ ... ] }
//         - { when: declined, steps: [ ... ] }
//     - { note: "The customer sees the result.", over: [api, db] }
//
// Message kinds: call (solid, the default), return (dashed), async (solid,
// open arrowhead: a report over a channel). `from` equal to `to` is a step a
// participant takes on its own.

import { useId, useState } from "react";
import { iconSet, nestedIcon } from "./icons";
import { textWidth } from "./text";
import { VOCABULARY } from "./vocabulary";

export interface SequenceSpec {
  type: "sequence";
  title?: string;
  participants: ParticipantSpec[];
  steps: Step[];
}

export interface ParticipantSpec {
  id: string;
  /** A building block from the vocabulary: gives the label and icon. */
  is?: string;
  label?: string;
  icon?: string;
}

export type Step =
  | { from: string; to: string; label: string; kind?: "call" | "return" | "async" }
  | { note: string; over: string | string[] }
  | { alt: { when: string; steps: Step[] }[] }
  | { par: { when?: string; steps: Step[] }[] }
  | { opt: string; steps: Step[] }
  | { loop: string; steps: Step[] }
  | { phase: string; steps: Step[] };

type Theme = "light" | "dark";

export function SequenceDiagram({ spec, theme, fixed }: { spec: SequenceSpec; theme: Theme; fixed: boolean }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  // Marker ids are per document, and each diagram's arrowheads take its own theme's colours.
  const ids = `seq${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  let drawing: Drawing;
  try {
    drawing = layoutSequence(spec, ids);
  } catch (e) {
    return <div className={`cd cd-${theme} cd-error`}>Couldn't lay out this diagram: {String(e)}</div>;
  }
  const { width, height, items } = drawing;
  return (
    <div className={`cd cd-${theme} cd-seq${fixed ? " cd-fixed" : ""}`} style={fixed ? { width, height } : undefined}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width={fixed ? width : "100%"}
        style={fixed ? undefined : { maxWidth: width, display: "block", margin: "0 auto" }}
        role="img"
        aria-label={spec.title}
        onClick={(e) => {
          if ((e.target as SVGElement).tagName === "svg") setSelected(null);
        }}
      >
        <defs>
          <marker id={`${ids}-filled`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto">
            <path d="M 0 0 L 10 5 L 0 10 z" className="cd-seq-head" />
          </marker>
          <marker id={`${ids}-open`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto">
            <path d="M 1 1 L 9 5 L 1 9" className="cd-seq-head-open" />
          </marker>
        </defs>
        {items.map((item, i) => item.draw({ key: i, hovered, setHovered, selected, setSelected }))}
      </svg>
    </div>
  );
}

// Layout

interface DrawContext {
  key: number;
  hovered: number | null;
  setHovered: (lane: number | null) => void;
  selected: number | null;
  setSelected: (updater: (prev: number | null) => number | null) => void;
}

interface Item {
  /** Lower draws first: bands, frames, lifelines, then messages and notes. */
  layer: number;
  draw: (ctx: DrawContext) => React.ReactElement;
}

interface Drawing {
  width: number;
  height: number;
  items: Item[];
}

const MARGIN = 20;
const HEAD_H = 46;
const ICON = 20;
const MSG_H = 36;
const SELF_H = 44;
const FRAME_HEAD = 30;
const FRAME_FOOT = 12;
const DIVIDER = 30;
const PHASE_HEAD = 30;

type Message = Extract<Step, { from: string }>;
type Note = Extract<Step, { note: string }>;

function isMessage(s: Step): s is Message {
  return "from" in s;
}

function frameOf(s: Step): { keyword: string; sections: { when?: string; steps: Step[] }[] } | null {
  if ("alt" in s) return { keyword: "alt", sections: s.alt };
  if ("par" in s) return { keyword: "par", sections: s.par };
  if ("opt" in s) return { keyword: "opt", sections: [{ when: s.opt, steps: s.steps }] };
  if ("loop" in s) return { keyword: "loop", sections: [{ when: s.loop, steps: s.steps }] };
  return null;
}

/** Long message labels break into lines of about 34 characters, so lanes stay close. */
function wrapMessage(label: string): string {
  return label
    .split("\n")
    .map((line) => {
      const out: string[] = [];
      let current = "";
      for (const word of line.split(" ")) {
        if (current && (current + " " + word).length > 34) {
          out.push(current);
          current = word;
        } else current = current ? `${current} ${word}` : word;
      }
      out.push(current);
      return out.join("\n");
    })
    .join("\n");
}

function wrapSteps(steps: Step[]): Step[] {
  return steps.map((s) => {
    if (isMessage(s)) return { ...s, label: wrapMessage(s.label) };
    if ("note" in s) return s;
    if ("phase" in s) return { ...s, steps: wrapSteps(s.steps) };
    if ("alt" in s) return { alt: s.alt.map((sec) => ({ ...sec, steps: wrapSteps(sec.steps) })) };
    if ("par" in s) return { par: s.par.map((sec) => ({ ...sec, steps: wrapSteps(sec.steps) })) };
    if ("opt" in s) return { ...s, steps: wrapSteps(s.steps) };
    return { ...s, steps: wrapSteps(s.steps) };
  });
}

function layoutSequence(original: SequenceSpec, ids: string): Drawing {
  const spec = { ...original, steps: wrapSteps(original.steps) };
  const parts = spec.participants.map((p) => {
    const block = p.is ? VOCABULARY[p.is] : undefined;
    if (p.is && !block) throw new Error(`${p.id}: "${p.is}" is not in the vocabulary`);
    return { id: p.id, label: p.label ?? block?.label ?? p.id, icon: p.icon ?? block?.icon };
  });
  const lane = new Map(parts.map((p, i) => [p.id, i]));
  const laneOf = (id: string) => {
    const i = lane.get(id);
    if (i === undefined) throw new Error(`unknown participant ${id}`);
    return i;
  };

  // Lane spacing: wide enough for every card and every message label.
  const cardW = parts.map((p) => Math.max(96, textWidth(p.label, 600, 13) + (p.icon ? ICON + 8 : 0) + 28));
  const gaps = parts.slice(1).map((_, i) => Math.max(140, cardW[i] / 2 + cardW[i + 1] / 2 + 32));
  let selfRoom = 0;
  const needs: { a: number; b: number; w: number }[] = [];
  const collect = (steps: Step[]) => {
    for (const s of steps) {
      if (isMessage(s)) {
        const a = laneOf(s.from);
        const b = laneOf(s.to);
        const w = Math.max(...s.label.split("\n").map((l) => textWidth(l, 400, 12))) + 48;
        if (a === b) {
          if (a < gaps.length) gaps[a] = Math.max(gaps[a], w + 30);
          else selfRoom = Math.max(selfRoom, w + 30);
        } else needs.push({ a: Math.min(a, b), b: Math.max(a, b), w });
      } else if ("note" in s) {
        continue;
      } else if ("phase" in s) {
        collect(s.steps);
      } else {
        for (const sec of frameOf(s)!.sections) collect(sec.steps);
      }
    }
  };
  collect(spec.steps);
  for (const { a, b, w } of needs.sort((x, y) => x.b - x.a - (y.b - y.a))) {
    const have = gaps.slice(a, b).reduce((s, g) => s + g, 0);
    if (have < w) for (let i = a; i < b; i++) gaps[i] += (w - have) / (b - a);
  }
  const x: number[] = [];
  let at = MARGIN + 40 + cardW[0] / 2;
  parts.forEach((_, i) => {
    x.push(at);
    at += gaps[i] ?? 0;
  });
  // Grows if a frame or note reaches further right (see `reach` below).
  let width = Math.ceil(x[x.length - 1] + Math.max(cardW[cardW.length - 1] / 2, selfRoom) + MARGIN + 40);
  // How far anything reaches left of the margin; the drawing shifts right by that much.
  let overflowLeft = 0;

  const items: Item[] = [];
  let y = MARGIN + HEAD_H + 22;
  let number = 0;

  // Participant cards and lifelines (lifelines get their length at the end).
  parts.forEach((p, i) => {
    const w = cardW[i];
    items.push({
      layer: 3,
      draw: ({ key, hovered, setHovered, selected, setSelected }) => {
        const isSelected = selected === i;
        const dim = selected !== null && !isSelected;
        return (
          <g
            key={key}
            className={`cd-seq-card${dim ? " cd-dim" : ""}${isSelected ? " cd-selected" : ""}`}
            onMouseEnter={() => setHovered(i)}
            onMouseLeave={() => setHovered(null)}
            onClick={() => setSelected((prev) => (prev === i ? null : i))}
            style={{ cursor: "pointer" }}
          >
            <rect x={x[i] - w / 2} y={MARGIN} width={w} height={HEAD_H} rx={10} className="cd-seq-card-box" />
            {p.icon && <g className={`cd-icon-${iconSet(p.icon)}`} dangerouslySetInnerHTML={{ __html: nestedIcon(p.icon, x[i] - w / 2 + 14, MARGIN + (HEAD_H - ICON) / 2, ICON) }} />}
            <text x={p.icon ? x[i] - w / 2 + 14 + ICON + 8 : x[i]} y={MARGIN + HEAD_H / 2 + 4.5} textAnchor={p.icon ? "start" : "middle"} className="cd-seq-name">
              {p.label}
            </text>
          </g>
        );
      },
    });
  });

  const extentOf = (steps: Step[]): [number, number] => {
    let lo = Infinity;
    let hi = -Infinity;
    const visit = (ss: Step[]) => {
      for (const s of ss) {
        if (isMessage(s)) {
          lo = Math.min(lo, laneOf(s.from), laneOf(s.to));
          hi = Math.max(hi, laneOf(s.from), laneOf(s.to));
        } else if ("note" in s) {
          for (const o of [s.over].flat()) {
            lo = Math.min(lo, laneOf(o));
            hi = Math.max(hi, laneOf(o));
          }
        } else if ("phase" in s) visit(s.steps);
        else for (const sec of frameOf(s)!.sections) visit(sec.steps);
      }
    };
    visit(steps);
    return [lo, hi];
  };
  // How far each step's drawing reaches, left and right, so frames enclose it.
  const noteBox = (s: Note) => {
    const over = [s.over].flat().map(laneOf);
    const lo = Math.min(...over);
    const hi = Math.max(...over);
    const textW = Math.max(...s.note.split("\n").map((l) => textWidth(l, 400, 12)));
    const cx = (x[lo] + x[hi]) / 2;
    const w = Math.max(x[hi] - x[lo] + 80, textW + 24);
    return { cx, w };
  };
  const FRAME_PAD = 14;
  const reach = (steps: Step[]): [number, number] => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of steps) {
      if (isMessage(s)) {
        const a = x[laneOf(s.from)];
        const b = x[laneOf(s.to)];
        const label = Math.max(...s.label.split("\n").map((l) => textWidth(l, 400, 12)));
        if (a === b) {
          lo = Math.min(lo, a - 12);
          hi = Math.max(hi, a + 36 + label + 6);
        } else {
          const mid = (a + b) / 2;
          lo = Math.min(lo, Math.min(a, b) - 12, mid - label / 2 - 6);
          hi = Math.max(hi, Math.max(a, b) + 12, mid + label / 2 + 6);
        }
      } else if ("note" in s) {
        const { cx, w } = noteBox(s);
        lo = Math.min(lo, cx - w / 2);
        hi = Math.max(hi, cx + w / 2);
      } else if ("phase" in s) {
        const [l, h] = reach(s.steps);
        lo = Math.min(lo, l);
        hi = Math.max(hi, h);
      } else {
        const [l, h] = frameBounds(s);
        lo = Math.min(lo, l);
        hi = Math.max(hi, h);
      }
    }
    return [lo, hi];
  };
  /** A frame's left and right edges: around everything in it, and wide enough for its labels. */
  const frameBounds = (s: Step): [number, number] => {
    const frame = frameOf(s)!;
    const [l, h] = reach(frame.sections.flatMap((sec) => sec.steps));
    const left = l - FRAME_PAD;
    const tabW = textWidth(frame.keyword, 700, 11) + 18;
    const labels = Math.max(0, ...frame.sections.map((sec, i) => (sec.when ? textWidth(`[${sec.when}]`, 400, 12) + (i === 0 ? tabW + 14 : 9) : 0)));
    return [left, Math.max(h + FRAME_PAD, left + labels + 16, left + 120)];
  };

  const depthOf = (steps: Step[]): number =>
    Math.max(0, ...steps.map((s) => (isMessage(s) || "note" in s ? 0 : "phase" in s ? depthOf(s.steps) : 1 + Math.max(...frameOf(s)!.sections.map((sec) => depthOf(sec.steps))))));

  const place = (steps: Step[]) => {
    for (const s of steps) {
      if (isMessage(s)) {
        const a = laneOf(s.from);
        const b = laneOf(s.to);
        const n = ++number;
        const kind = s.kind ?? "call";
        const rowY = y;
        if (a === b) {
          const selfLines = s.label.split("\n");
          y += SELF_H + 16 * (selfLines.length - 1);
          items.push({
            layer: 6,
            draw: ({ key, hovered, selected }) => {
              const active = selected ?? null;
              const touches = (active ?? hovered) === a;
              const dim = active !== null && selected !== a;
              return (
                <g key={key} className={`cd-seq-msg${dim ? " cd-dim" : ""}${touches ? " cd-lit" : ""}`}>
                  <path d={`M ${x[a]} ${rowY + 16} h 28 v 16 h -26`} className={`cd-seq-line${kind === "return" ? " cd-dashed" : ""}`} markerEnd={`url(#${ids}-${kind === "call" ? "filled" : "open"})`} fill="none" />
                  <Num n={n} cx={x[a]} cy={rowY + 16} />
                  {selfLines.map((l, i) => (
                    <text key={i} x={x[a] + 36} y={rowY + 28 + 16 * i} className="cd-seq-label">
                      {l}
                    </text>
                  ))}
                </g>
              );
            },
          });
        } else {
          const labelLines = s.label.split("\n");
          y += MSG_H + 16 * (labelLines.length - 1);
          const lineY = rowY + 24 + 16 * (labelLines.length - 1);
          const dir = Math.sign(b - a);
          items.push({
            layer: 6,
            draw: ({ key, hovered, selected }) => {
              const active = selected ?? null;
              const touches = (active ?? hovered) === a || (active ?? hovered) === b;
              const dim = active !== null && selected !== a && selected !== b;
              return (
                <g key={key} className={`cd-seq-msg${dim ? " cd-dim" : ""}${touches ? " cd-lit" : ""}`}>
                  <line x1={x[a] + dir * 9} y1={lineY} x2={x[b] - dir * 2} y2={lineY} className={`cd-seq-line${kind === "return" ? " cd-dashed" : ""}`} markerEnd={`url(#${ids}-${kind === "call" ? "filled" : "open"})`} />
                  <Num n={n} cx={x[a]} cy={lineY} />
                  {labelLines.map((l, i) => (
                    <text key={i} x={(x[a] + x[b]) / 2} y={lineY - 7 - 16 * (labelLines.length - 1 - i)} textAnchor="middle" className="cd-seq-label">
                      {l}
                    </text>
                  ))}
                </g>
              );
            },
          });
        }
      } else if ("note" in s) {
        const over = [s.over].flat().map(laneOf);
        const lo = Math.min(...over);
        const hi = Math.max(...over);
        const noteLines = s.note.split("\n");
        const { cx, w } = noteBox(s);
        width = Math.max(width, Math.ceil(cx + w / 2 + MARGIN + 8));
        overflowLeft = Math.max(overflowLeft, MARGIN - (cx - w / 2));
        const h = 12 + noteLines.length * 16;
        const top = y + 6;
        y += h + 14;
        items.push({
          layer: 7,
          draw: ({ key }) => (
            <g key={key} className="cd-seq-note">
              <rect x={cx - w / 2} y={top} width={w} height={h} rx={6} className="cd-seq-note-box" />
              {noteLines.map((l, i) => (
                <text key={i} x={cx} y={top + 18 + i * 16} textAnchor="middle" className="cd-seq-note-text">
                  {l}
                </text>
              ))}
            </g>
          ),
        });
      } else if ("phase" in s) {
        const top = y;
        y += PHASE_HEAD;
        place(s.steps);
        y += 8;
        const bottom = y;
        y += 10;
        items.push({
          layer: 0,
          draw: ({ key }) => (
            <g key={key} className="cd-seq-phase">
              <rect x={MARGIN} y={top} width={width - 2 * MARGIN} height={bottom - top} rx={8} className="cd-seq-phase-box" />
              <text x={MARGIN + 12} y={top + 19} className="cd-seq-phase-label">
                {s.phase}
              </text>
            </g>
          ),
        });
      } else {
        const frame = frameOf(s)!;
        const [lo, hi] = extentOf(frame.sections.flatMap((sec) => sec.steps));
        const [left, right] = frameBounds(s);
        width = Math.max(width, Math.ceil(right + MARGIN + 8));
        overflowLeft = Math.max(overflowLeft, MARGIN - left);
        const top = y;
        const dividers: { y: number; when?: string }[] = [];
        y += FRAME_HEAD;
        frame.sections.forEach((sec, i) => {
          if (i > 0) {
            dividers.push({ y, when: sec.when });
            y += DIVIDER;
          }
          place(sec.steps);
        });
        y += FRAME_FOOT;
        const bottom = y;
        y += 8;
        const first = frame.sections[0].when;
        const tabW = textWidth(frame.keyword, 700, 11) + 18;
        items.push({
          layer: 2,
          draw: ({ key }) => (
            <g key={key} className="cd-seq-frame">
              <rect x={left} y={top} width={right - left} height={bottom - top} rx={6} className="cd-seq-frame-box" />
              <path d={`M ${left} ${top + 20} h ${tabW} l 6 -6 v -14`} className="cd-seq-frame-tab-line" fill="none" />
              <rect x={left} y={top} width={tabW} height={20} rx={6} className="cd-seq-frame-tab" />
              <text x={left + 9} y={top + 14} className="cd-seq-frame-keyword">
                {frame.keyword}
              </text>
              {first && (
                <text x={left + tabW + 14} y={top + 14} className="cd-seq-frame-when">
                  [{first}]
                </text>
              )}
              {dividers.map((d, i) => (
                <g key={i}>
                  <line x1={left} y1={d.y + 6} x2={right} y2={d.y + 6} className="cd-seq-divider" />
                  {d.when && (
                    <text x={left + 9} y={d.y + 22} className="cd-seq-frame-when">
                      [{d.when}]
                    </text>
                  )}
                </g>
              ))}
            </g>
          ),
        });
      }
    }
  };
  place(spec.steps);
  const height = Math.ceil(y + MARGIN);

  parts.forEach((_, i) => {
    items.push({
      layer: 1,
      draw: ({ key, hovered, selected }) => {
        const lit = selected === i || (selected === null && hovered === i);
        return <line key={key} x1={x[i]} y1={MARGIN + HEAD_H} x2={x[i]} y2={height - MARGIN} className={`cd-seq-lifeline${lit ? " cd-lit" : ""}`} />;
      },
    });
  });
  items.sort((a, b) => a.layer - b.layer);
  if (overflowLeft > 0) {
    const shift = Math.ceil(overflowLeft) + 8;
    const shifted = items.map((item) => ({ ...item, draw: (ctx: DrawContext) => <g key={ctx.key} transform={`translate(${shift} 0)`}>{item.draw({ ...ctx, key: 0 })}</g> }));
    return { width: width + shift, height, items: shifted };
  }
  return { width, height, items };
}

function Num({ n, cx, cy }: { n: number; cx: number; cy: number }) {
  return (
    <g className="cd-seq-num">
      <circle cx={cx} cy={cy} r={8} />
      <text x={cx} y={cy + 3.5} textAnchor="middle">
        {n}
      </text>
    </g>
  );
}
