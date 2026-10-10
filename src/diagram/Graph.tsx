// Graph diagrams: boxes and arrows, laid out by ELK (layered, orthogonal
// edges) and drawn by React Flow.
//
//   title: The shop on one machine
//   direction: RIGHT            # or DOWN
//   nodes:
//     - { id: machine, label: Your machine, icon: "lucide:laptop", kind: boundary }
//     - { id: api, in: machine, is: API, detail: "serves the web shop" }
//     - { id: ready, shape: decision, label: "Dependencies\nall ended?" }
//     - { id: ok, shape: state, label: success, tone: good }
//   edges:
//     - { from: browser, to: serve, label: HTTP, style: dashed }
//
// Shapes: box (the default: icon, label, detail, tags), decision (a diamond),
// state (a status, as a pill), start and end (dots), entity (a table name with
// its fields), note (a dashed box of text). A node that other nodes are `in`,
// or one with `kind: boundary | process`, is drawn as a box around them.
// `\n` in a label breaks the line.

import { Controls, type Edge, type Node, ReactFlow, ReactFlowProvider } from "@xyflow/react";
import ELK, { type ElkExtendedEdge, type ElkNode } from "elkjs/lib/elk.bundled.js";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { EDGE_TYPES, Hover, Markers, NODE_TYPES } from "./GraphNodes";
import { MONO, lines, textWidth } from "./text";
import { VOCABULARY } from "./vocabulary";

export interface GraphSpec {
  type?: "graph";
  title?: string;
  direction?: "RIGHT" | "DOWN";
  nodes: NodeSpec[];
  edges?: EdgeSpec[];
}

export interface NodeSpec {
  id: string;
  /** A building block from the vocabulary: gives the label and icon. */
  is?: string;
  label?: string;
  /** A second, smaller line: what runs there, or how. */
  detail?: string;
  icon?: string;
  /** The id of the box this node sits in. */
  in?: string;
  /** boundary: an account, project or machine (dashed); process: one running program (solid). */
  kind?: "boundary" | "process";
  shape?: "box" | "decision" | "state" | "start" | "end" | "entity" | "note";
  /** Colour for a result: good (green), bad (red), quiet (grey), accent (blue). */
  tone?: "good" | "bad" | "quiet" | "accent";
  /** Short facts shown as pills: "scales to zero", "1 instance". */
  tags?: string[];
  /** An entity's fields, one line each: "name text UK". */
  fields?: string[];
  /** Where clicking the node goes (a relative doc link). */
  link?: string;
}

export interface EdgeSpec {
  from: string;
  to: string;
  label?: string;
  /** dashed: polling, background or optional traffic. */
  style?: "solid" | "dashed";
  /** Arrowheads at both ends. */
  both?: boolean;
  /** Part of the main path: ELK keeps it straight, and the other edges go around it. */
  main?: boolean;
}

type Theme = "light" | "dark";

export function GraphDiagram({ spec, theme, fixed, fullScreen = false, onLink }: { spec: GraphSpec; theme: Theme; fixed: boolean; fullScreen?: boolean; onLink?: (link: string) => void }) {
  const [layout, setLayout] = useState<Layout | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    layoutGraph(spec)
      .then((l) => live && setLayout(l))
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [spec]);
  if (error) return <div className={`cd cd-${theme} cd-error`}>Couldn't lay out this diagram: {error}</div>;
  if (!layout) return <div className={`cd cd-${theme} cd-loading`} style={{ height: 120 }} />;
  return (
    <ReactFlowProvider>
      <Canvas layout={layout} theme={theme} fixed={fixed} fullScreen={fullScreen} onLink={onLink} />
    </ReactFlowProvider>
  );
}

// Layout

interface Layout {
  width: number;
  height: number;
  nodes: Node[];
  edges: Edge[];
}

const MARGIN = 24;
const ICON = 36; // the box icon size, as drawn in GraphNodes
const GROUP_HEADER = 40;
const elk = new ELK();

/** The node with its vocabulary defaults filled in. */
function resolved(n: NodeSpec): NodeSpec & { label: string } {
  const block = n.is ? VOCABULARY[n.is] : undefined;
  if (n.is && !block) throw new Error(`${n.id}: "${n.is}" is not in the vocabulary`);
  return { ...n, label: n.label ?? block?.label ?? n.id, icon: n.icon ?? block?.icon };
}

async function layoutGraph(spec: GraphSpec): Promise<Layout> {
  const all = spec.nodes.map(resolved);
  const byId = new Map(all.map((n) => [n.id, n]));
  const kids = new Map<string | undefined, (NodeSpec & { label: string })[]>();
  for (const n of all) {
    if (n.in && !byId.has(n.in)) throw new Error(`${n.id} is in unknown node ${n.in}`);
    kids.set(n.in, [...(kids.get(n.in) ?? []), n]);
  }
  const isGroup = (n: NodeSpec) => !!n.kind || kids.has(n.id);
  // Decisions with a `main` answer get fixed tips for their edges; a many-way
  // decision without one fans out freely.
  const hasMain = new Set((spec.edges ?? []).filter((e) => e.main && byId.get(e.from)?.shape === "decision").map((e) => e.from));

  const toElk = (n: NodeSpec & { label: string }): ElkNode => {
    if (isGroup(n)) {
      const headerWidth = ICON + textWidth(n.label, 600, 13) + (n.detail ? textWidth(n.detail, 400, 12) + 16 : 0) + 40;
      return {
        id: n.id,
        layoutOptions: {
          "elk.padding": `[top=${GROUP_HEADER + 12},left=20,bottom=20,right=20]`,
          "elk.nodeSize.constraints": "MINIMUM_SIZE",
          "elk.nodeSize.minimum": `(${Math.ceil(headerWidth)}, 80)`,
        },
        children: (kids.get(n.id) ?? []).map(toElk),
      };
    }
    const size = leafSize(n);
    if (n.shape !== "decision" || !hasMain.has(n.id)) return { id: n.id, ...size };
    // A diamond's edges meet its tips: in at the back, the main answer out of
    // the front, the other answers out of the side.
    const down = (spec.direction ?? "RIGHT") === "DOWN";
    const { width: w, height: h } = size;
    const tip = (side: string, x: number, y: number) => ({ id: `${n.id}:${side}`, width: 0, height: 0, x, y });
    return {
      id: n.id,
      ...size,
      layoutOptions: { "elk.portConstraints": "FIXED_POS" },
      ports: down ? [tip("in", w / 2, 0), tip("main", w / 2, h), tip("side", w, h / 2)] : [tip("in", 0, h / 2), tip("main", w, h / 2), tip("side", w / 2, h)],
    };
  };

  for (const e of spec.edges ?? []) {
    if (!byId.has(e.from) || !byId.has(e.to)) throw new Error(`edge ${e.from} → ${e.to} names an unknown node`);
  }
  const graph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": spec.direction ?? "RIGHT",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.spacing.nodeNodeBetweenLayers": "64",
      "elk.spacing.nodeNode": "36",
      "elk.layered.spacing.edgeNodeBetweenLayers": "28",
      "elk.spacing.edgeEdge": "22",
      "elk.spacing.edgeLabel": "4",
      "elk.edgeLabels.placement": "CENTER",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      // Nodes and edges keep the order they're written in where they can, so
      // the author decides which way a cycle (retry, resume) points back.
      "elk.layered.cycleBreaking.strategy": "MODEL_ORDER",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.json.shapeCoords": "ROOT",
      "elk.json.edgeCoords": "ROOT",
    },
    children: (kids.get(undefined) ?? []).map(toElk),
    edges: (spec.edges ?? []).map(
      (e, i): ElkExtendedEdge => ({
        id: `e${i}`,
        sources: [hasMain.has(e.from) ? `${e.from}:${e.main ? "main" : "side"}` : e.from],
        targets: [hasMain.has(e.to) ? `${e.to}:in` : e.to],
        labels: e.label ? [labelBox(e.label)] : [],
        layoutOptions: e.main ? { "elk.layered.priority.straightness": "20", "elk.layered.priority.direction": "20" } : undefined,
      }),
    ),
  };
  const done = await elk.layout(graph);

  const nodes: Node[] = [];
  const walk = (n: ElkNode, depth: number) => {
    for (const c of n.children ?? []) {
      const s = byId.get(c.id)!;
      const group = isGroup(s);
      nodes.push({
        id: c.id,
        type: group ? "box" : (s.shape ?? "service"),
        position: { x: (c.x ?? 0) + MARGIN, y: (c.y ?? 0) + MARGIN },
        data: { spec: s },
        width: c.width,
        height: c.height,
        style: { width: c.width, height: c.height },
        draggable: false,
        selectable: false,
        // Boxes go under the arrows; what's inside them goes over.
        zIndex: group ? -10 + depth : 10,
      });
      walk(c, depth + 1);
    }
  };
  walk(done, 0);

  const specEdges = spec.edges ?? [];
  const edges: Edge[] = (done.edges ?? []).map((e, i) => {
    const es = specEdges[i];
    // An edge that crosses into or out of a box comes in several sections, one per level.
    const points = inPathOrder(e.sections ?? [])
      .flatMap((sec) => [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint])
      .map((p) => ({ x: p.x + MARGIN, y: p.y + MARGIN }))
      .filter((p, i, all) => i === 0 || p.x !== all[i - 1].x || p.y !== all[i - 1].y);
    const label = e.labels?.[0];
    return {
      id: e.id,
      source: es.from,
      target: es.to,
      type: "elk",
      zIndex: 5,
      data: {
        points,
        label: es.label ? wrapLabel(es.label).join("\n") : undefined,
        // On the line itself (which runs behind it), so it's clear which line a label names.
        labelAt: !label
          ? null
          : es.from === es.to
            ? // A loop: beside it, where ELK left room, not on top of it.
              { x: (label.x ?? 0) + MARGIN + (label.width ?? 0) / 2, y: (label.y ?? 0) + MARGIN + (label.height ?? 0) / 2 }
            : // Where ELK left room for it, moved onto the line so it's clear which line it names.
              onLine(points, { x: (label.x ?? 0) + MARGIN + (label.width ?? 0) / 2, y: (label.y ?? 0) + MARGIN + (label.height ?? 0) / 2 }),
        dashed: es.style === "dashed",
        both: !!es.both,
      },
    };
  });
  return { width: (done.width ?? 0) + 2 * MARGIN, height: (done.height ?? 0) + 2 * MARGIN, nodes, edges };
}

/** Long edge labels break into lines of about 24 characters, so they don't push boxes apart. */
function wrapLabel(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    let current = "";
    for (const word of line.split(" ")) {
      if (current && (current + " " + word).length > 24) {
        out.push(current);
        current = word;
      } else current = current ? `${current} ${word}` : word;
    }
    out.push(current);
  }
  return out;
}

function labelBox(text: string): { text: string; width: number; height: number } {
  const ls = wrapLabel(text);
  return { text, width: Math.max(...ls.map((l) => textWidth(l, 400, 12))) + 12, height: 4 + 16 * ls.length };
}

/**
 * A label on a horizontal stretch moves onto its line. Next to a vertical
 * stretch it stays where ELK put it, beside the line: centred on the line it
 * would cover its neighbours.
 */
function onLine(points: { x: number; y: number }[], p: { x: number; y: number }): { x: number; y: number } {
  const q = nearestOnPath(points, p);
  return Math.abs(q.y - p.y) >= Math.abs(q.x - p.x) ? q : p;
}

/** The point of the edge's path nearest to `p`. */
function nearestOnPath(points: { x: number; y: number }[], p: { x: number; y: number }): { x: number; y: number } {
  let best = p;
  let bestDistance = Infinity;
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1], points[i]];
    const length2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
    const t = length2 ? Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / length2)) : 0;
    const q = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < bestDistance) {
      bestDistance = d;
      best = q;
    }
  }
  return best;
}

type Section = NonNullable<ElkExtendedEdge["sections"]>[number];

/** Sections chained from the edge's source to its target. */
function inPathOrder(sections: Section[]): Section[] {
  if (sections.length < 2) return sections;
  const byId = new Map(sections.map((sec) => [sec.id, sec]));
  let at = sections.find((sec) => !sec.incomingSections?.length) ?? sections[0];
  const out: Section[] = [];
  const seen = new Set<string>();
  while (at && !seen.has(at.id)) {
    out.push(at);
    seen.add(at.id);
    at = byId.get(at.outgoingSections?.[0] ?? "")!;
  }
  return out.length === sections.length ? out : sections;
}

function widest(text: string | undefined, weight: number, size: number): number {
  return Math.max(0, ...lines(text).map((l) => textWidth(l, weight, size)));
}

function leafSize(n: NodeSpec & { label: string }): { width: number; height: number } {
  const labelLines = lines(n.label).length;
  switch (n.shape) {
    case "start":
    case "end":
      return { width: 22, height: 22 };
    case "state":
      return { width: Math.round(Math.max(90, widest(n.label, 600, 13) + 36)), height: 24 + 18 * labelLines };
    case "decision": {
      const w = widest(n.label, 500, 12);
      return { width: Math.round(Math.max(140, w * 1.5 + 40)), height: Math.round(Math.max(70, 16 * labelLines * 1.6 + 36)) };
    }
    case "entity": {
      // A field is its name (monospace), a gap, then the rest.
      const field = (f: string) => {
        const [name, ...rest] = f.trim().split(/\s+/);
        return textWidth(name, 400, 12, MONO) + 10 + textWidth(rest.join(" "), 400, 12);
      };
      const w = Math.max(widest(n.label, 600, 13), ...(n.fields ?? []).map(field));
      return { width: Math.round(Math.max(150, w + 36)), height: 36 + 20 * (n.fields?.length ?? 0) + 8 };
    }
    case "note": {
      const w = Math.min(280, Math.max(widest(n.label, 400, 12), widest(n.detail, 400, 12)));
      return { width: Math.round(w + 40), height: 22 + 16 * (labelLines + lines(n.detail).length) };
    }
    default: {
      const label = widest(n.label, 600, 13);
      const detail = widest(n.detail, 400, 12);
      const tags = (n.tags ?? []).reduce((w, t) => w + textWidth(t, 500, 11) + 18, 0);
      const icon = n.icon ? ICON + 12 : 0;
      const text = Math.max(label, Math.min(detail, 220), tags);
      // Room for the icon, the gap, padding, borders, and a little slack for font differences.
      const width = Math.round(Math.min(320, Math.max(icon ? 150 : 110, icon + text + 40)));
      const textRoom = width - icon - 40;
      const detailLines = lines(n.detail).reduce((sum, l) => sum + Math.max(1, Math.ceil(textWidth(l, 400, 12) / textRoom)), 0);
      const height = Math.max(icon ? 64 : 44, 22 + 18 * labelLines + detailLines * 16 + (n.tags?.length ? 24 : 0));
      return { width, height };
    }
  }
}

// Drawing

function Canvas({ layout, theme, fixed, fullScreen, onLink }: { layout: Layout; theme: Theme; fixed: boolean; fullScreen: boolean; onLink?: (link: string) => void }) {
  const [hovered, setHovered] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const edgesOf = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const e of layout.edges) {
      for (const end of [e.source, e.target]) m.set(end, (m.get(end) ?? new Set()).add(e.id));
    }
    return m;
  }, [layout]);
  // On a page: as wide as the page, and as tall as the diagram is at that width
  // (never larger than 100%), so the text stays readable and no space is wasted.
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    if (fixed || !box.current) return;
    let frame = 0;
    const observer = new ResizeObserver(([entry]) => {
      // Changing the width state also changes this observed box's height.
      // Defer that render beyond ResizeObserver's current delivery cycle.
      cancelAnimationFrame(frame);
      const next = { width: entry.contentRect.width, height: entry.contentRect.height };
      frame = requestAnimationFrame(() => setSize((old) => old.width === next.width && old.height === next.height ? old : next));
    });
    observer.observe(box.current);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [fixed]);
  const { width } = size;
  const fitScale = width ? Math.min(1, width / layout.width, fullScreen ? size.height / layout.height : 1) : 1;
  // Fullscreen is a reading view. A large diagram must not shrink its labels
  // into a thumbnail; pan to follow it, or use Fit for a whole-diagram overview.
  const scale = fullScreen ? Math.max(0.9, fitScale) : fitScale;
  const height = fullScreen ? "100%" : fixed ? layout.height : Math.ceil(layout.height * scale);
  const viewport = fullScreen ? {
    x: layout.width * scale > width ? MARGIN : (width - layout.width * scale) / 2,
    y: layout.height * scale > size.height ? MARGIN : (size.height - layout.height * scale) / 2,
    zoom: scale,
  } : { x: 0, y: 0, zoom: fixed ? 1 : scale };
  const marker = `cd${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  return (
    <Hover.Provider value={{ hovered, selected, edgesOf, marker }}>
      <div ref={box} className={`cd cd-${theme}${fixed ? " cd-fixed" : ""}${!fixed && !fullScreen ? " cd-inline-graph" : ""}`} style={fixed ? { width: layout.width, height } : { height }}>
        <Markers id={marker} />
        {(fixed || (size.width > 0 && (!fullScreen || size.height > 0))) && <ReactFlow
          key={fixed ? "fixed" : fullScreen ? `full${Math.round(width)}x${Math.round(size.height)}` : `w${Math.round(width)}`}
          nodes={layout.nodes}
          edges={layout.edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          colorMode={theme}
          fitView={false}
          defaultViewport={viewport}
          // Keep inline views fixed even when node focus or internal handlers
          // request a viewport adjustment. Fullscreen remains interactive.
          viewport={fullScreen ? undefined : viewport}
          minZoom={Math.min(0.2, scale || 0.2)}
          maxZoom={2}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          autoPanOnNodeFocus={fullScreen}
          autoPanOnSelection={fullScreen}
          selectionKeyCode={null}
          zoomOnScroll={fullScreen}
          preventScrolling={fullScreen}
          panOnDrag={fullScreen}
          panOnScroll={false}
          zoomOnPinch={fullScreen}
          zoomOnDoubleClick={fullScreen}
          panActivationKeyCode={fullScreen ? "Space" : null}
          zoomActivationKeyCode={fullScreen ? undefined : null}
          proOptions={{ hideAttribution: true }}
          onNodeMouseEnter={(_, n) => setHovered(n.id)}
          onNodeMouseLeave={() => setHovered(null)}
          onNodeClick={(_, n) => {
            setSelected((prev) => (prev === n.id ? null : n.id));
            const link = (n.data as { spec: NodeSpec }).spec.link;
            if (link) onLink?.(link);
          }}
          onPaneClick={() => setSelected(null)}
        >
          {fullScreen && <Controls showInteractive={false} position="top-right" />}
        </ReactFlow>}
      </div>
    </Hover.Provider>
  );
}
