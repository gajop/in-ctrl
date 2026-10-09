// The pieces of a graph diagram React Flow draws: the node shapes, the
// edges along ELK's routes, and their arrowheads.

import { BaseEdge, type EdgeProps, EdgeLabelRenderer, Handle, type NodeProps, Position } from "@xyflow/react";
import { createContext, useContext } from "react";
import type { NodeSpec } from "./Graph";
import { iconSet, iconSvg } from "./icons";
import { lines } from "./text";

const ICON = 36;

export type NodeSpecWithLabel = NodeSpec & { label: string };

export const Hover = createContext<{ hovered: string | null; selected: string | null; edgesOf: Map<string, Set<string>>; marker: string }>({ hovered: null, selected: null, edgesOf: new Map(), marker: "" });

function Icon({ id, size }: { id?: string; size: number }) {
  const svg = iconSvg(id);
  if (!svg) return null;
  return <span className={`cd-icon cd-icon-${iconSet(id)}`} style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: svg }} />;
}

/** Whether a node fades while another one is selected (it isn't connected to it). */
function useDim(id: string): boolean {
  const { selected, edgesOf } = useContext(Hover);
  if (selected === null) return false;
  return selected !== id && ![...(edgesOf.get(selected) ?? [])].some((e) => edgesOf.get(id)?.has(e));
}

function Handles() {
  return (
    <>
      <Handle type="target" position={Position.Left} className="cd-handle" />
      <Handle type="source" position={Position.Right} className="cd-handle" />
    </>
  );
}

function Lines({ text, className }: { text?: string; className: string }) {
  return (
    <>
      {lines(text).map((l, i) => (
        <div key={i} className={className}>
          {l}
        </div>
      ))}
    </>
  );
}

type Spec = NodeSpecWithLabel;
const specOf = (data: unknown) => (data as { spec: Spec }).spec;
const linked = (s: Spec) => (s.link ? " cd-linked" : "");

function ServiceNode({ data, id }: NodeProps) {
  const s = specOf(data);
  const dim = useDim(id);
  return (
    <div className={`cd-node${s.tone ? ` cd-tone-${s.tone}` : ""}${dim ? " cd-dim" : ""}${linked(s)}`}>
      <Handles />
      <Icon id={s.icon} size={ICON} />
      <div className="cd-text">
        <Lines text={s.label} className="cd-label" />
        <Lines text={s.detail} className="cd-detail" />
        {!!s.tags?.length && (
          <div className="cd-tags">
            {s.tags.map((t) => (
              <span key={t} className="cd-tag">
                {t}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StateNode({ data, id }: NodeProps) {
  const s = specOf(data);
  return (
    <div className={`cd-state cd-tone-${s.tone ?? "plain"}${useDim(id) ? " cd-dim" : ""}${linked(s)}`}>
      <Handles />
      <Lines text={s.label} className="cd-label" />
    </div>
  );
}

function TerminalNode({ data, id }: NodeProps) {
  const s = specOf(data);
  return (
    <div className={`cd-terminal cd-terminal-${s.shape}${useDim(id) ? " cd-dim" : ""}`}>
      <Handles />
    </div>
  );
}

function DecisionNode({ data, id }: NodeProps) {
  const s = specOf(data);
  return (
    <div className={`cd-decision${useDim(id) ? " cd-dim" : ""}${linked(s)}`}>
      <Handles />
      <svg className="cd-diamond" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <polygon points="50,1 99,50 50,99 1,50" />
      </svg>
      <div className="cd-decision-text">
        <Lines text={s.label} className="cd-decision-label" />
      </div>
    </div>
  );
}

function EntityNode({ data, id }: NodeProps) {
  const s = specOf(data);
  return (
    <div className={`cd-entity${useDim(id) ? " cd-dim" : ""}${linked(s)}`}>
      <Handles />
      <div className="cd-entity-head">{s.label}</div>
      {(s.fields ?? []).map((f) => {
        const [name, ...rest] = f.trim().split(/\s+/);
        return (
          <div key={f} className="cd-entity-field">
            <span className="cd-field-name">{name}</span>
            <span className="cd-field-rest">{rest.join(" ")}</span>
          </div>
        );
      })}
    </div>
  );
}

function NoteNode({ data, id }: NodeProps) {
  const s = specOf(data);
  return (
    <div className={`cd-note${useDim(id) ? " cd-dim" : ""}`}>
      <Handles />
      <Lines text={s.label} className="cd-note-label" />
      <Lines text={s.detail} className="cd-detail" />
    </div>
  );
}

function GroupNode({ data }: NodeProps) {
  const s = specOf(data);
  return (
    <div className={`cd-group cd-group-${s.kind ?? "process"}`}>
      <div className="cd-group-head">
        <Icon id={s.icon} size={20} />
        <span className="cd-group-label">{s.label}</span>
        {s.detail && <span className="cd-group-detail">{s.detail}</span>}
      </div>
      <Handles />
    </div>
  );
}

function ElkEdge({ id, data }: EdgeProps) {
  const d = data as { points: { x: number; y: number }[]; label?: string; labelAt: { x: number; y: number } | null; dashed: boolean; both: boolean };
  const { hovered, selected, edgesOf, marker } = useContext(Hover);
  const active = selected ?? null;
  const lit =
    (selected !== null && edgesOf.get(selected)?.has(id)) ||
    (selected === null && hovered !== null && edgesOf.get(hovered)?.has(id));
  const dim = active !== null && !lit;
  const path = roundedPath(d.points, 8);
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        className={`cd-edge${d.dashed ? " cd-dashed" : ""}${lit ? " cd-lit" : ""}${dim ? " cd-dim" : ""}`}
        markerEnd={`url(#${marker}${lit ? "-lit" : ""})`}
        markerStart={d.both ? `url(#${marker}${lit ? "-lit" : ""})` : undefined}
      />
      {d.label && d.labelAt && (
        <EdgeLabelRenderer>
          <div
            className={`cd-edge-label${lit ? " cd-lit" : ""}${dim ? " cd-dim" : ""}`}
            style={{ transform: `translate(-50%, -50%) translate(${d.labelAt.x}px, ${d.labelAt.y}px)` }}
          >
            {d.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

/** An orthogonal polyline with its corners rounded. */
function roundedPath(raw: { x: number; y: number }[], radius: number): string {
  if (raw.length < 2) return "";
  // ELK can leave points a fraction of a pixel off a straight line; snap them,
  // or the corners turn into short diagonals.
  const points = raw.map((p) => ({ ...p }));
  for (let i = 1; i < points.length; i++) {
    if (Math.abs(points[i].x - points[i - 1].x) < 1.5) points[i].x = points[i - 1].x;
    if (Math.abs(points[i].y - points[i - 1].y) < 1.5) points[i].y = points[i - 1].y;
  }
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [a, b, c] = [points[i - 1], points[i], points[i + 1]];
    const r = Math.min(radius, Math.hypot(b.x - a.x, b.y - a.y) / 2, Math.hypot(c.x - b.x, c.y - b.y) / 2);
    const inX = b.x - Math.sign(b.x - a.x) * r;
    const inY = b.y - Math.sign(b.y - a.y) * r;
    const outX = b.x + Math.sign(c.x - b.x) * r;
    const outY = b.y + Math.sign(c.y - b.y) * r;
    path += ` L ${inX} ${inY} Q ${b.x} ${b.y} ${outX} ${outY}`;
  }
  const last = points[points.length - 1];
  return `${path} L ${last.x} ${last.y}`;
}

// Not "group": React Flow styles its own group type with a border.
export const NODE_TYPES = {
  service: ServiceNode,
  box: GroupNode,
  state: StateNode,
  start: TerminalNode,
  end: TerminalNode,
  decision: DecisionNode,
  entity: EntityNode,
  note: NoteNode,
};
export const EDGE_TYPES = { elk: ElkEdge };

/** Arrowheads in the diagram's colours (one set per diagram: marker ids are per document). */
export function Markers({ id }: { id: string }) {
  return (
    <svg className="cd-markers" aria-hidden="true">
      <defs>
        {["", "-lit"].map((v) => (
          <marker key={v} id={`${id}${v}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" className={`cd-arrowhead${v}`} />
          </marker>
        ))}
      </defs>
    </svg>
  );
}
