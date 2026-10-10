// Loads the system model (model/*.yaml) and generated data, and indexes them.

import YAML from "yaml";
import metaJson from "/generated/meta.json";
import pagesJson from "/generated/pages.json";
import refsJson from "/generated/refs.json";
import branchIndexJson from "/generated/branches/index.json";

export type ElementKind =
  | "system"
  | "external"
  | "crate"
  | "module"
  | "fn"
  | "type"
  | "trait"
  | "table"
  | "channel"
  | "process"
  | "state"
  | "ui"
  | "config";

export interface ModelElement {
  id: string;
  name: string;
  kind: ElementKind;
  description?: string;
  code?: string;
  parent?: string;
  children?: ModelElement[];
}

export interface ModelRelation {
  from: string;
  to: string;
  label?: string;
  kind?: "call" | "data" | "channel" | "spawn" | "http" | "sql" | "transition" | "impl";
}

export interface FlowStep {
  from?: string;
  to?: string;
  label?: string;
  /** Previous label of a `changed` step, shown struck through in the diff view. */
  was?: string;
  kind?: "call" | "return" | "async";
  change?: "added" | "removed" | "changed";
  /** Where the bug is: a short reason, shown in red next to this step (not in the After view). */
  problem?: string;
  code?: string;
  note?: string;
  over?: string[];
  loop?: string;
  alt?: string;
  opt?: string;
  par?: string;
  else?: string;
  end?: boolean;
}

export interface Flow {
  id: string;
  title?: string;
  participants: string[];
  steps: FlowStep[];
}

export interface View {
  id: string;
  title?: string;
  include: string[];
  expand?: string[];
  direction?: "RIGHT" | "DOWN";
  /** Extra ELK layout options, e.g. {"elk.edgeRouting": "SPLINES"}. */
  layout?: Record<string, string>;
}

export interface Model {
  elements: Map<string, ModelElement>;
  relations: ModelRelation[];
  flows: Map<string, Flow>;
  views: Map<string, View>;
}

export interface RefInfo {
  file: string;
  line: number | null;
  ok: boolean;
  reason?: string;
}

export interface PageInfo {
  path: string;
  title: string;
  section: string;
  order: number;
  branch: string | null;
  /** Path of the page this one sits under in the sidebar. */
  parent: string | null;
  summary: string;
  /** Review pages: the glance line (see glance.ts). */
  kind?: string;
  risk?: string;
  areas?: string[];
  flows?: string[];
  oneliner?: string;
  breaking?: string;
}

export interface Hunk {
  oldStart: number;
  newStart: number;
  context: string;
  lines: string[];
}

export interface BranchData {
  name: string;
  parent: string;
  commit: string;
  subject: string;
  body: string;
  /** Every commit in the branch, oldest first. */
  commits?: { hash: string; subject: string; body: string }[];
  files: {
    file: string;
    /** A(dded), D(eleted), M(odified) */
    status: string;
    added: number;
    removed: number;
    hunks: Hunk[];
    /** The same diff with whitespace changes ignored (`git diff -w`). */
    hunksNoWs: Hunk[];
    /** fn name → line spans in the branch's version of the file */
    symbols?: Record<string, [number, number][]>;
    /** Markdown files: the file as the branch leaves it, for the Preview toggle. */
    preview?: string;
  }[];
}

interface ModelFile {
  source?: string;
  elements?: ModelElement[];
  relations?: ModelRelation[];
  flows?: Flow[];
  views?: View[];
}

export interface AnnotationKind {
  id: string;
  label: string;
  color: string;
  description?: string;
}

export const meta = metaJson as {
  repoRoot: string;
  editorLink: string;
  annotationKinds: AnnotationKind[];
  generatedAt: string;
};
export const pages = pagesJson as PageInfo[];
export const refs = refsJson as Record<string, RefInfo>;

/** Every branch, without its diffs: what the sidebar and headers show before a branch loads. */
export interface BranchSummary {
  name: string;
  parent: string;
  subject: string;
  merged: boolean;
  added: number;
  removed: number;
  commitCount: number;
  diagrams: number;
  /** Lines changed per part of the project (maps.yaml containers). */
  impact: Record<string, { lines: number; files: number; added: number; removed: number }>;
  /** For review progress; the same hash as patchHash() in store.ts. */
  files: { file: string; hash: string }[];
}
export const branchIndex = branchIndexJson as BranchSummary[];

export const model: Model = buildModel(
  Object.entries(
    import.meta.glob("/model/*.yaml", { query: "?raw", import: "default", eager: true }) as Record<string, string>,
  ).flatMap(([file, text]) => {
    try {
      return [{ ...(YAML.parse(text) as ModelFile), source: file }];
    } catch (err) {
      console.error(`model: ${file} failed to parse and was skipped`, err);
      return [];
    }
  }),
);

const branchLoaders = import.meta.glob("/generated/branches/*.json", { import: "default" });

export async function loadBranch(name: string): Promise<BranchData | null> {
  const loader = branchLoaders[`/generated/branches/${name.replaceAll("/", "__")}.json`];
  return loader ? ((await loader()) as BranchData) : null;
}

/**
 * The model plus every element defined in any inline overlay on this page, so a
 * seq-flow can use participants a sibling sys-graph introduces. Relations stay
 * local to the component that declares them (see withOverlay).
 */
export function pageModel(): Model {
  if (cachedPageModel) return cachedPageModel;
  const extra: ModelElement[] = [];
  for (const script of document.querySelectorAll<HTMLScriptElement>(
    'sys-graph > script[type="application/yaml"], seq-flow > script[type="application/yaml"]',
  )) {
    try {
      const parsed = YAML.parse(script.textContent ?? "") as ModelFile | null;
      extra.push(...(parsed?.elements ?? []));
    } catch (err) {
      console.error("inline overlay failed to parse", err, script.textContent);
    }
  }
  const pageElements = buildModel([{ elements: extra }]).elements;
  const elements = new Map(model.elements);
  for (const [id, el] of pageElements) elements.set(id, { ...elements.get(id), ...el });
  cachedPageModel = { ...model, elements };
  return cachedPageModel;
}

/** Forget the current page's overlays (client-side navigation swaps the page). */
export function resetPageModel() {
  cachedPageModel = null;
}

/**
 * Page model plus a component's overlay. Overlay relations come first and
 * replace a model relation with the same from/to (e.g. to relabel it); with
 * `localOnly`, only the overlay's relations are used.
 */
export function withOverlay(overlay: ModelFile | null, localOnly = false): Model {
  const base = pageModel();
  if (!overlay) return localOnly ? { ...base, relations: [] } : base;
  const extra = buildModel([overlay]);
  const own = new Set(extra.relations.map((r) => `${r.from}->${r.to}`));
  return {
    elements: base.elements,
    relations: [
      ...extra.relations,
      ...(localOnly ? [] : base.relations.filter((r) => !own.has(`${r.from}->${r.to}`))),
    ],
    flows: new Map([...base.flows, ...extra.flows]),
    views: new Map([...base.views, ...extra.views]),
  };
}

export function ancestors(m: Model, id: string): string[] {
  const out: string[] = [];
  let current = m.elements.get(id)?.parent;
  while (current) {
    out.push(current);
    current = m.elements.get(current)?.parent;
  }
  return out;
}

export function childrenOf(m: Model, id: string): ModelElement[] {
  return [...m.elements.values()].filter((el) => el.parent === id);
}

/** Touch devices: no hover, and editor links (vscode://…) don't open anything. */
export const coarsePointer = window.matchMedia("(pointer: coarse)").matches;

export function editorHref(ref: string): string | null {
  const info = refs[ref];
  if (!info?.ok) return null;
  return meta.editorLink
    .replace("{abs}", `${meta.repoRoot}/${info.file}`)
    .replace("{line}", String(info.line ?? 1));
}

export function parseInlineYaml<T>(host: Element): T | null {
  const script = host.querySelector('script[type="application/yaml"]');
  return script?.textContent ? (YAML.parse(script.textContent) as T) : null;
}

export function splitIds(value: string | null): string[] {
  return (value ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Helpers

let cachedPageModel: Model | null = null;

function buildModel(files: ModelFile[]): Model {
  const elements = new Map<string, ModelElement>();
  const origin = new Map<string, string>();
  const add = (el: ModelElement, source: string, parent?: string) => {
    const { children, ...rest } = el;
    if (origin.has(el.id) && origin.get(el.id) !== source) {
      console.warn(`model: element ${el.id} is defined in ${origin.get(el.id)} and ${source}`);
    }
    origin.set(el.id, source);
    elements.set(el.id, { ...rest, parent: el.parent ?? parent });
    for (const child of children ?? []) add(child, source, el.id);
  };
  const m: Model = { elements, relations: [], flows: new Map(), views: new Map() };
  for (const file of files) {
    for (const el of file.elements ?? []) add(el, file.source ?? "overlay");
    m.relations.push(...(file.relations ?? []));
    for (const flow of file.flows ?? []) m.flows.set(flow.id, flow);
    for (const view of file.views ?? []) m.views.set(view.id, view);
  }
  return m;
}
