// Zoom (ctrl/cmd + wheel, buttons, pinch) and drag-to-pan for an SVG inside a
// frame, plus a fullscreen toggle. Plain wheel keeps scrolling the page.
// The frame is wrapped in a box that holds the buttons (−, +, Fit, fullscreen),
// so they stay in the diagram's top-right corner when the frame scrolls.

export function attachPanZoom(frame: HTMLElement, svg: SVGSVGElement) {
  const box = document.createElement("div");
  box.className = "diagram-box";
  frame.replaceWith(box);
  box.append(frame);
  const base = svg.viewBox.baseVal;
  const natural = { x: base.x, y: base.y, w: base.width, h: base.height };
  let initial = { ...natural };
  let view = { ...initial };
  const apply = () => svg.setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${view.h}`);
  // Draw at `scale` of the natural size, but at least as wide as the frame.
  // The extra width goes to both sides of the viewBox: the diagram is centered,
  // and zooming in uses the whole frame instead of stopping at the drawing's edge.
  const size = (scale: number) => {
    const available = contentWidth(frame);
    const width = Math.max(natural.w * scale, available);
    const extra = width / scale - natural.w;
    initial = { x: natural.x - extra / 2, y: natural.y, w: natural.w + extra, h: natural.h };
    view = { ...initial };
    svg.setAttribute("width", String(Math.floor(width)));
    svg.setAttribute("height", String(Math.floor(natural.h * scale)));
    apply();
    frame.classList.toggle("overflowing", width > available + 1);
  };
  size(Number(svg.getAttribute("width")) / natural.w);
  const zoom = (factor: number, cx = 0.5, cy = 0.5) => {
    const w = view.w * factor;
    const h = view.h * factor;
    view = { x: view.x + (view.w - w) * cx, y: view.y + (view.h - h) * cy, w, h };
    apply();
  };

  frame.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      zoom(e.deltaY > 0 ? 1.15 : 1 / 1.15, (e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height);
    },
    { passive: false },
  );

  // Mouse/pen: drag pans. Touch: two fingers pinch-zoom (and pan); one finger
  // pans once zoomed in or in fullscreen, otherwise it scrolls the page;
  // double-tap resets.
  type Pt = { x: number; y: number };
  let gesture: { view: typeof view; points: Pt[] } | null = null;
  const zoomed = () => Math.abs(view.w - initial.w) > 0.5 || box.classList.contains("fullscreen");
  const move = (points: Pt[]) => {
    if (!gesture) return;
    const rect = svg.getBoundingClientRect();
    const start = gesture.points;
    const center = (pts: Pt[]) => ({
      x: pts.reduce((a, p) => a + p.x, 0) / pts.length,
      y: pts.reduce((a, p) => a + p.y, 0) / pts.length,
    });
    const dist = (pts: Pt[]) => Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
    const factor = points.length >= 2 && start.length >= 2 ? dist(start) / dist(points) : 1;
    const c0 = center(start);
    const c1 = center(points);
    const scale = gesture.view.w / rect.width;
    const w = gesture.view.w * factor;
    const h = gesture.view.h * factor;
    // Keep the point under the gesture's start center under the current center.
    const fx = (c0.x - rect.left) / rect.width;
    const fy = (c0.y - rect.top) / rect.height;
    view = {
      x: gesture.view.x + fx * (gesture.view.w - w) - (c1.x - c0.x) * scale * factor,
      y: gesture.view.y + fy * (gesture.view.h - h) - (c1.y - c0.y) * scale * factor,
      w,
      h,
    };
    apply();
  };

  const mouse = new Map<number, Pt>();
  svg.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "touch" || (e.target as Element).closest(".linked")) return;
    mouse.set(e.pointerId, { x: e.clientX, y: e.clientY });
    svg.setPointerCapture(e.pointerId);
    gesture = { view: { ...view }, points: [...mouse.values()] };
  });
  svg.addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch" || !mouse.has(e.pointerId)) return;
    mouse.set(e.pointerId, { x: e.clientX, y: e.clientY });
    move([...mouse.values()]);
  });
  const endMouse = (e: PointerEvent) => {
    if (!mouse.delete(e.pointerId)) return;
    gesture = mouse.size ? { view: { ...view }, points: [...mouse.values()] } : null;
  };
  svg.addEventListener("pointerup", endMouse);
  svg.addEventListener("pointercancel", endMouse);

  const touchPoints = (e: TouchEvent): Pt[] => [...e.touches].map((t) => ({ x: t.clientX, y: t.clientY }));
  let lastTap = 0;
  let moved = false;
  svg.addEventListener(
    "touchstart",
    (e) => {
      moved = false;
      const pts = touchPoints(e);
      gesture = pts.length >= 2 || zoomed() ? { view: { ...view }, points: pts } : null;
    },
    { passive: true },
  );
  svg.addEventListener(
    "touchmove",
    (e) => {
      if (!gesture) return;
      e.preventDefault();
      moved = true;
      const pts = touchPoints(e);
      if (pts.length !== gesture.points.length) gesture = { view: { ...view }, points: pts };
      move(pts);
    },
    { passive: false },
  );
  svg.addEventListener("touchend", (e) => {
    const pts = touchPoints(e);
    gesture = pts.length && gesture ? { view: { ...view }, points: pts } : null;
    if (pts.length === 0 && !moved && e.changedTouches.length === 1) {
      const now = Date.now();
      if (now - lastTap < 300 && zoomed()) {
        view = { ...initial };
        apply();
      }
      lastTap = now;
    }
  });

  // Fit: the whole diagram in view. In fullscreen the SVG fills the box and
  // the viewBox scales it; otherwise it is sized to the frame's width.
  const fit = () => {
    if (!box.classList.contains("fullscreen")) return size(Math.min(1, contentWidth(frame) / natural.w));
    view = { ...initial };
    apply();
  };

  const bar = document.createElement("div");
  bar.className = "graph-toolbar";
  const button = (label: string, title: string, onClick: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.title = title;
    b.addEventListener("click", onClick);
    bar.append(b);
    return b;
  };
  button("−", "Zoom out (or ctrl + wheel)", () => zoom(1.25));
  button("+", "Zoom in (or ctrl + wheel)", () => zoom(1 / 1.25));
  button("Fit", "Show the whole diagram", fit);
  button("⛶", "Fullscreen (Esc to leave)", () => {
    box.classList.toggle("fullscreen");
    view = { ...initial };
    apply();
  });
  // The legend stays out of the way until "?" is pressed.
  const host = box.parentElement;
  if (host?.querySelector(":scope > .legend") || host?.localName === "sys-graph") {
    button("?", "Legend and controls", () => host.classList.toggle("help-open")).classList.add("help");
  }
  box.append(bar);
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") document.querySelectorAll(".diagram-box.fullscreen").forEach((b) => b.classList.remove("fullscreen"));
});

// Helpers

function contentWidth(el: HTMLElement): number {
  const style = getComputedStyle(el);
  return el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
}
