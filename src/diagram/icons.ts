// Icons by "set:name" id. The host adds the ones its diagrams use (the CLI and
// the site build them from the diagram sources; see src/node/icons.mjs).

const icons: Record<string, string> = {};

/** Make icons available to diagrams: id → inline SVG markup. */
export function addIcons(more: Record<string, string>) {
  Object.assign(icons, more);
}

/** The icon's SVG markup, or undefined for an unknown id. */
export function iconSvg(id: string | undefined): string | undefined {
  return id ? icons[id] : undefined;
}

/** The icon placed inside an SVG drawing, at (x, y) and `size` square. */
export function nestedIcon(id: string | undefined, x: number, y: number, size: number): string {
  const svg = iconSvg(id);
  if (!svg) return "";
  return svg.replace("<svg ", `<svg x="${x}" y="${y}" width="${size}" height="${size}" class="cd-icon-${id!.split(":")[0]}" `);
}

/** One-colour icon sets, which take a colour from the theme. */
export function iconSet(id: string | undefined): string {
  return id?.split(":")[0] ?? "";
}
