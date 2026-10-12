// A modal reading view shared by live graph and sequence diagrams.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { Theme } from "./Diagram";

export function DiagramView({ title, theme, kind, children }: { title?: string; theme: Theme; kind: "graph" | "sequence" | "map"; children: (fullScreen: boolean) => ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const [inlineHeight, setInlineHeight] = useState<number>();
  const inline = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const closer = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!expanded || !dialog.current) return;
    const modal = dialog.current;
    const previousOverflow = document.documentElement.style.overflow;
    modal.showModal();
    modal.dispatchEvent(new CustomEvent("in-ctrl:diagram-view", { bubbles: true, composed: true, detail: { expanded: true } }));
    document.documentElement.style.overflow = "hidden";
    closer.current?.focus();
    return () => {
      modal.close();
      modal.dispatchEvent(new CustomEvent("in-ctrl:diagram-view", { bubbles: true, composed: true, detail: { expanded: false } }));
      document.documentElement.style.overflow = previousOverflow;
      opener.current?.focus({ preventScroll: true });
    };
  }, [expanded]);

  return (
    <div className={`cd cd-${theme} cd-frame`}>
      <div className="cd-view-tools">
        <DiagramHelp kind={kind} fullScreen={false} />
        <button ref={opener} type="button" className="cd-view-button" aria-haspopup="dialog" onClick={() => {
          setInlineHeight(inline.current?.getBoundingClientRect().height);
          setExpanded(true);
        }}>
          <ExpandIcon /> Full screen
        </button>
      </div>
      <div ref={inline} style={expanded ? { height: inlineHeight } : undefined}>
        {!expanded && children(false)}
      </div>
      <dialog ref={dialog} className={`cd cd-${theme} cd-fullscreen`} aria-label={title || "Diagram"} onClose={() => setExpanded(false)}>
        <header className="cd-view-header">
          <strong>{title || "Diagram"}</strong>
          <div className="cd-view-actions">
            <slot name="diagram-comment-tools" />
            <DiagramHelp kind={kind} fullScreen />
            <button ref={closer} type="button" className="cd-view-button" onClick={() => setExpanded(false)}>
              <ExpandIcon exit /> Exit full screen
            </button>
          </div>
        </header>
        <div className="cd-view-content">{expanded && children(true)}</div>
        <slot name="diagram-comment-overlay" />
      </dialog>
    </div>
  );
}

function DiagramHelp({ kind, fullScreen }: { kind: "graph" | "sequence" | "map"; fullScreen: boolean }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      // The site mounts diagrams in shadow roots; document targets are retargeted.
      if (!event.composedPath().includes(root.current!)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      button.current?.focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside, true);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside, true);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open]);

  return <div className="cd-diagram-help" ref={root}>
    <button ref={button} type="button" className="cd-view-button cd-info-button" aria-label="Diagram help" title="Diagram help" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" /><path d="M12 11v6" /><circle cx="12" cy="7" r=".5" fill="currentColor" />
      </svg>
    </button>
    {open && <div id={id} className="cd-help-panel" role="region" aria-label="Diagram controls">
      <strong>Diagram controls</strong>
      {!fullScreen && <p>Scroll or swipe the page normally. Open Full screen to explore the diagram.</p>}
      {kind === "map" ? <>
        <p>Point at the map to read the values and names under the pointer. Steps, if any, have a slider; layers can be turned off.</p>
        <p>In fullscreen, drag to pan and use the wheel to zoom.</p>
      </> : kind === "graph" ? <>
        <p>In fullscreen, drag or swipe to pan. Use the wheel, pinch, or +/− controls to zoom.</p>
        <p>Fit view shows the whole graph.</p>
      </> : <p>In fullscreen, scroll or swipe across the full-size sequence.</p>}
      <p>Exit full screen or press Escape to return. Escape closes this help first.</p>
    </div>}
  </div>;
}

function ExpandIcon({ exit = false }: { exit?: boolean }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={exit ? "M8 3v5H3m18 0h-5V3M3 16h5v5m8 0v-5h5" : "M8 3H3v5m18 0V3h-5M3 16v5h5m8 0h5v-5"} />
  </svg>;
}
