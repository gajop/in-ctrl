// A docs diagram, from a `*.diagram.yaml` file next to the doc that shows it.
// Two kinds:
//
// - type: graph (the default): boxes with product icons, nested boundaries,
//   decisions and states, labelled arrows; laid out by ELK, drawn by React
//   Flow. See Graph.tsx.
// - type: sequence: participants and the messages between them over time,
//   with alt/opt/loop/par frames and phases. See Sequence.tsx.
// - type: map: things laid out in space and drawn to scale: grids of values,
//   shapes and paths in layers, optionally in steps. See Map.tsx.
//
// Names from the project's vocabulary (`is: API`) get the same label and
// icon everywhere (vocabulary.ts).

import { DiagramView } from "./DiagramView";
import { GraphDiagram, type GraphSpec } from "./Graph";
import { MapDiagram, type MapSpec } from "./Map";
import { SequenceDiagram, type SequenceSpec } from "./Sequence";

export { addIcons } from "./icons";
export { setVocabulary, type Block } from "./vocabulary";
export type { GraphSpec, MapSpec, SequenceSpec };
export type DiagramSpec = GraphSpec | SequenceSpec | MapSpec;
export type Theme = "light" | "dark";

/** Draw `spec`. `fixed` draws it at 100% with no controls, for rendering to an image. */
/** `onLink` is called with a node's `link` when it is clicked. */
export function Diagram({ spec, theme, fixed = false, onLink }: { spec: DiagramSpec; theme: Theme; fixed?: boolean; onLink?: (link: string) => void }) {
  const draw = (fullScreen: boolean) => spec.type === "sequence" ? (
    <SequenceDiagram spec={spec} theme={theme} fixed={fixed} fullScreen={fullScreen} />
  ) : spec.type === "map" ? (
    <MapDiagram spec={spec} theme={theme} fixed={fixed} fullScreen={fullScreen} />
  ) : (
    <GraphDiagram spec={spec} theme={theme} fixed={fixed} fullScreen={fullScreen} onLink={onLink} />
  );
  // PNG rendering stays exactly at the source dimensions, without reading controls.
  return fixed ? draw(false) : <DiagramView title={spec.title} theme={theme} kind={spec.type === "sequence" ? "sequence" : spec.type === "map" ? "map" : "graph"}>{draw}</DiagramView>;
}
