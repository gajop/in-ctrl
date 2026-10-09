// A docs diagram, from a `*.diagram.yaml` file next to the doc that shows it.
// Two kinds:
//
// - type: graph (the default): boxes with product icons, nested boundaries,
//   decisions and states, labelled arrows; laid out by ELK, drawn by React
//   Flow. See Graph.tsx.
// - type: sequence: participants and the messages between them over time,
//   with alt/opt/loop/par frames and phases. See Sequence.tsx.
//
// Names from the project's vocabulary (`is: API`) get the same label and
// icon everywhere (vocabulary.ts).

import { GraphDiagram, type GraphSpec } from "./Graph";
import { SequenceDiagram, type SequenceSpec } from "./Sequence";

export { addIcons } from "./icons";
export { setVocabulary, type Block } from "./vocabulary";
export type { GraphSpec, SequenceSpec };
export type DiagramSpec = GraphSpec | SequenceSpec;
export type Theme = "light" | "dark";

/** Draw `spec`. `fixed` draws it at 100% with no controls, for rendering to an image. */
/** `onLink` is called with a node's `link` when it is clicked. */
export function Diagram({ spec, theme, fixed = false, onLink }: { spec: DiagramSpec; theme: Theme; fixed?: boolean; onLink?: (link: string) => void }) {
  return spec.type === "sequence" ? (
    <SequenceDiagram spec={spec} theme={theme} fixed={fixed} />
  ) : (
    <GraphDiagram spec={spec} theme={theme} fixed={fixed} onLink={onLink} />
  );
}
