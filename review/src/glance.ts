// The "at a glance" line of a review page: one shared set of symbols, so a
// reviewer can skim a list of branches and know what each one is before
// reading it. Pages set it with metas:
//
//   <meta name="guide:kind" content="security">          see KINDS
//   <meta name="guide:areas" content="cart, API">         free-form, short
//   <meta name="guide:oneliner" content="Coupons take **a discount** off the total …">
//   <meta name="guide:breaking" content="`total()` takes a second argument">   optional
//
// The risk comes from <review-header risk="…">. One-liners allow **bold**
// and `code`, nothing else.

import { settings } from "./settings";
import mapsJson from "/generated/maps.json";
import { pages, type PageInfo, branchIndex } from "./data";
import { escapeHtml } from "./diff";

export const KINDS: Record<string, { icon: string; label: string; hint: string }> = {
  security: { icon: "🔒", label: "Security", hint: "closes a hole someone could use" },
  fix: { icon: "🐞", label: "Fix", hint: "something was broken; now it works" },
  feature: { icon: "✨", label: "Feature", hint: "something new you can do" },
  cleanup: { icon: "🧹", label: "Cleanup", hint: "removes or reorganises; behaviour stays" },
  deps: { icon: "📦", label: "Dependencies", hint: "updates third-party code" },
  docs: { icon: "📝", label: "Docs", hint: "documentation only" },
  tests: { icon: "🧪", label: "Tests", hint: "tests only" },
  tooling: { icon: "🛠", label: "Tooling", hint: "lint, build or CI; not the product" },
};

export const RISKS: Record<string, { icon: string; label: string; hint: string }> = {
  low: { icon: "🟢", label: "low risk", hint: "hard to get wrong; skim it" },
  medium: { icon: "🟡", label: "medium risk", hint: "read the summary and the important notes" },
  high: { icon: "🔴", label: "high risk", hint: "read it all" },
};

export const BREAKING = { icon: "⚠️", label: "You'll notice", hint: "existing setups behave differently or need a change" };

/** `**bold**` and `` `code` `` in an otherwise plain one-liner. */
export function inline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

/** Kind and risk as two symbols, for the sidebar and lists. */
export function symbols(p: Pick<PageInfo, "kind" | "risk" | "breaking">): string {
  const kind = p.kind ? KINDS[p.kind] : null;
  const risk = p.risk ? RISKS[p.risk] : null;
  return [
    kind ? `<span class="g-sym" title="${escapeHtml(kind.label)}">${kind.icon}</span>` : "",
    risk ? `<span class="g-sym" title="${escapeHtml(risk.label)}">${risk.icon}</span>` : "",
    p.breaking ? `<span class="g-sym" title="${escapeHtml(BREAKING.label)}: ${escapeHtml(p.breaking)}">${BREAKING.icon}</span>` : "",
  ].join("");
}

/** Kind, risk and areas, for the top right of a review page. */
export function glanceChips(p: PageInfo): string {
  const kind = p.kind ? KINDS[p.kind] : null;
  const risk = p.risk ? RISKS[p.risk] : null;
  return [
    kind ? `<span class="g-chip g-kind-${escapeHtml(p.kind!)}" title="${escapeHtml(kind.hint)}">${kind.icon} ${kind.label}</span>` : "",
    risk ? `<span class="g-chip g-risk-${escapeHtml(p.risk!)}" title="${escapeHtml(risk.hint)}">${risk.icon} ${risk.label}</span>` : "",
    p.areas?.length ? `<span class="g-areas-text">${p.areas.map(escapeHtml).join(" · ")}</span>` : "",
  ].join("");
}

/** The one-liner, and what you'll notice if anything. */
export function glanceText(p: PageInfo): string {
  return `${p.oneliner ? `<p class="g-oneliner">${inline(p.oneliner)}</p>` : ""}${
    p.breaking ? `<p class="g-breaking">${BREAKING.icon} <strong>${BREAKING.label}:</strong> ${inline(p.breaking)}</p>` : ""
  }`;
}

/** <glance-legend>: what the symbols mean. */
export class GlanceLegend extends HTMLElement {
  connectedCallback() {
    const row = (icon: string, label: string, hint: string) => `<li><span class="g-sym">${icon}</span> <strong>${escapeHtml(label)}</strong>: ${escapeHtml(hint)}</li>`;
    this.innerHTML = `<details class="g-legend"><summary>What the symbols mean</summary>
      <div class="g-legend-cols">
        <ul>${Object.values(KINDS).map((k) => row(k.icon, k.label, k.hint)).join("")}</ul>
        <ul>${Object.values(RISKS).map((r) => row(r.icon, r.label, r.hint)).join("")}${row(BREAKING.icon, BREAKING.label, BREAKING.hint)}</ul>
      </div></details>`;
  }
}

/** <review-list parent="/pages/…">: the branches under a page, one line each. */
export class ReviewList extends HTMLElement {
  connectedCallback() {
    const parent = this.getAttribute("parent") ?? location.pathname;
    const rows = pages
      .filter((p) => p.parent === parent && p.branch)
      .map(
        (p) => `<tr>
          <td class="g-syms">${symbols(p)}</td>
          <td><a href="${p.path}">${escapeHtml(p.title)}</a>${p.oneliner ? `<div class="g-row-oneliner">${inline(p.oneliner)}</div>` : ""}</td>
          <td class="g-areas">${(p.areas ?? []).map((a) => `<span class="g-chip g-area">${escapeHtml(a)}</span>`).join("")}</td>
        </tr>`,
      )
      .join("");
    this.innerHTML = `<glance-legend></glance-legend><table class="grid g-list"><tbody>${rows}</tbody></table>`;
  }
}

// <review-summary>: the executive summary of a review page, in fixed rows
// (Why, What, Impact, Risk) next to a small map of the project with the parts
// the change touches lit up. Fields come from inline YAML; each value allows
// **bold** and `code`. Areas come from the page's guide:areas.
//
//   <review-summary><script type="application/yaml">
//   why: …
//   what: …
//   impact: …
//   risk: …
//   </script></review-summary>

const ROWS: [string, string][] = [
  ["why", "Why"],
  ["what", "What"],
  ["impact", "Impact"],
  ["risk", "Risk"],
];

type Impact = Record<string, { lines: number; files: number; added: number; removed: number }>;

// `href`: the guide page of the doc that explains it (from `doc:` in maps.yaml).
interface Container { id: string; name: string; description: string; x: number; y: number; w: number; href?: string }
// `self`: the project itself, among what's around it.
interface Context { id: string; name: string; description: string; self?: boolean }
interface Step { id: string; name: string; in: string[]; href?: string }
interface Flow { id: string; name: string; steps: Step[]; href?: string }
interface Journey { id: string; name: string; description: string; flows: Flow[]; href?: string }
export interface Maps {
  structure: { context: Context[]; containers: Container[] };
  flows: Journey[];
}
export const maps = mapsJson as unknown as Maps;
/** Where boxes and flows without a doc of their own link (review.mapsPage). */
const MAPS_PAGE = settings.mapsPage;

/** The structure map, level 2: each container shaded by how many lines the branch changes in it (log scale: 1000+ is full). */
export function impactMap(impact: Impact): string {
  if (!maps.structure.containers.length) return "";
  const boxes = maps.structure.containers
    .map((m) => {
      const hit = impact[m.id];
      const strength = hit ? 0.2 + 0.8 * Math.min(1, Math.log10(hit.lines + 1) / 3) : 0;
      const tip = `${m.name}: ${m.description}${hit ? `\n+${hit.added} −${hit.removed} in ${hit.files} file${hit.files === 1 ? "" : "s"}` : "\nuntouched"}`;
      const small = m.w < 60;
      return `<a href="${m.href ?? MAPS_PAGE}"><g class="im-box${hit ? " on" : ""}${strength > 0.55 ? " strong" : ""}"><title>${escapeHtml(tip)}</title>
      <rect x="${m.x}" y="${m.y}" width="${m.w}" height="32" rx="6" style="--im-strength:${strength.toFixed(2)}"/>
      <text x="${m.x + m.w / 2}" y="${m.y + (hit ? 14 : 20)}" class="${small ? "im-small" : ""}">${m.name}</text>
      ${hit ? `<text x="${m.x + m.w / 2}" y="${m.y + 26}" class="im-count">${hit.lines >= 1000 ? `${(hit.lines / 1000).toFixed(1)}k` : hit.lines} lines</text>` : ""}</g></a>`;
    })
    .join("");
  const bottom = Math.max(...maps.structure.containers.map((c) => c.y)) + 36;
  return `<figure class="impact-map"><svg viewBox="0 0 200 ${bottom}" role="img" aria-label="Lines changed per part of ${escapeHtml(settings.name)}">${boxes}</svg></figure>`;
}

/** The flows a branch changes (its `guide:flows` steps): each one as a line of steps, the changed ones lit. */
export function flowsPanel(stepIds: string[]): string {
  if (!stepIds.length) return "";
  const lit = new Set(stepIds);
  const rows: string[] = [];
  for (const journey of maps.flows) {
    for (const flow of journey.flows) {
      const touched = flow.steps.filter((s) => lit.has(`${flow.id}.${s.id}`) || lit.has(flow.id));
      if (!touched.length) continue;
      const steps = flow.steps
        .map((s) => {
          const on = lit.has(`${flow.id}.${s.id}`) || lit.has(flow.id);
          const where = s.in.map((c) => maps.structure.containers.find((x) => x.id === c)?.name ?? c).join(", ");
          return `<a class="fl-step${on ? " on" : ""}" href="${s.href ?? flow.href ?? journey.href ?? MAPS_PAGE}" title="${escapeHtml(`${s.name} — in: ${where}`)}">${escapeHtml(s.name)}</a>`;
        })
        .join('<span class="fl-arrow">→</span>');
      rows.push(`<div class="fl-row"><a class="fl-name" href="${flow.href ?? journey.href ?? MAPS_PAGE}"><span class="fl-journey">${escapeHtml(journey.name)} ›</span> ${escapeHtml(flow.name)}</a><div class="fl-steps">${steps}</div></div>`);
    }
  }
  return rows.length ? `<div class="flows-panel"><div class="fl-title">Affected flows</div>${rows.join("")}</div>` : "";
}

export class ReviewSummary extends HTMLElement {
  async connectedCallback() {
    if (this.dataset.rendered) return;
    this.dataset.rendered = "1";
    const { default: YAML } = await import("yaml");
    const fields = (YAML.parse(this.querySelector('script[type="application/yaml"]')?.textContent ?? "") ?? {}) as Record<string, string>;
    const page = pages.find((p) => p.path === location.pathname);
    const branch = branchIndex.find((b) => b.name === page?.branch);
    const rows = ROWS.filter(([key]) => fields[key])
      .map(([key, label]) => `<div class="rs-row rs-${key}"><dt>${label}</dt><dd>${inline(String(fields[key]))}</dd></div>`)
      .join("");
    // The one-liner and what you'll notice lead the summary; the header above keeps just the title.
    // A page that draws its flows' diagrams before and after doesn't repeat them as chips.
    this.innerHTML = `<div class="review-summary"><div class="rs-main">${page ? glanceText(page) : ""}<dl>${rows}</dl></div>${impactMap((branch?.impact ?? {}) as Impact)}${document.querySelector("docs-diagram script[data-before]") || (branch as { diagrams?: number } | undefined)?.diagrams ? "" : flowsPanel(page?.flows ?? [])}</div>`;
  }
}

// <project-maps>: the whole of maps.yaml, for a page about the codebase:
// level 1 (the project and what's around it), level 2 (its containers), and
// every journey with its flows and steps.
export class ProjectMaps extends HTMLElement {
  connectedCallback() {
    const name = (id: string) => maps.structure.containers.find((c) => c.id === id)?.name ?? id;
    const context = maps.structure.context
      .map((c) => `<div class="mp-ctx${c.self ? " mp-self" : ""}"><strong>${escapeHtml(c.name)}</strong><span>${inline(c.description)}</span></div>`)
      .join("");
    const containers = maps.structure.containers
      .map((c) => `<tr id="c-${c.id}"><td><strong>${escapeHtml(c.name)}</strong></td><td>${inline(c.description)}</td></tr>`)
      .join("");
    const journeys = maps.flows
      .map(
        (j) => `<section class="mp-journey"><h3>${escapeHtml(j.name)}</h3><p class="muted">${inline(j.description)}</p>${j.flows
          .map(
            (f) => `<div class="fl-row" id="f-${f.id}"><div class="fl-name">${escapeHtml(f.name)} <code class="mp-id">${escapeHtml(f.id)}</code></div><div class="fl-steps">${f.steps
              .map((s) => `<span class="fl-step" title="${escapeHtml(`${f.id}.${s.id} — in: ${s.in.map(name).join(", ")}`)}">${escapeHtml(s.name)}</span>`)
              .join('<span class="fl-arrow">→</span>')}</div></div>`,
          )
          .join("")}</section>`,
      )
      .join("");
    this.innerHTML = `
      <h2>Level 1: ${escapeHtml(settings.name)} and what's around it</h2>
      <div class="mp-context">${context}</div>
      <h2>Level 2: what ${escapeHtml(settings.name)} is made of</h2>
      <div class="mp-level2">${impactMap({})}<table class="grid">${containers}</table></div>
      <h2>Flows</h2>
      <p>${maps.flows.length} journey${maps.flows.length === 1 ? "" : "s"}, each split into flows of a few steps. Review pages light up the steps a branch changes; hover a step to see which parts it runs in.</p>
      ${journeys}`;
  }
}
