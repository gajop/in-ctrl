// Text measuring for layout: the same font the diagrams draw with.

export const FONT = "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
export const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

let measure: CanvasRenderingContext2D | null = null;

export function textWidth(text: string, weight: number, size: number, family = FONT): number {
  measure ??= document.createElement("canvas").getContext("2d");
  if (!measure) return text.length * size * 0.6;
  measure.font = `${weight} ${size}px ${family}`;
  return measure.measureText(text).width;
}

/** A label's lines (`\n` breaks them). */
export function lines(text: string | undefined): string[] {
  return text ? text.split("\n") : [];
}
