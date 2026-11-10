// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The large view of a diagram: zoom buttons, + - 0 1 keys, Ctrl+wheel, and drag to pan. It opens at the fit scale.
import { Maximize, ZoomIn, ZoomOut } from "lucide-react";
import { type KeyboardEvent, type PointerEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { fitZoom, ZOOM_MAX, ZOOM_MIN, zoomIn, zoomOut, zoomPercent } from "./zoom";

// The padding of the view box on both sides: p-3 twice.
const PAD = 24;

type Size = { w: number; h: number };
type Point = { x: number; y: number };

function Viewer({ src, title }: { src: string; title: string }) {
  const box = useRef<HTMLElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [size, setSize] = useState<Size | null>(null);
  const [room, setRoom] = useState<Size>({ w: 0, h: 0 });
  const [drag, setDrag] = useState<(Point & { left: number; top: number }) | null>(null);
  // The image point under the anchor, in unscaled pixels, and the anchor in client pixels. The scroll keeps it in place.
  const anchor = useRef<{ at: Point; image: Point } | null>(null);
  const scale = size && zoom === "fit" ? fitZoom(size, room) : zoom === "fit" ? 1 : zoom;

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setRoom({ w: el.clientWidth - PAD, h: el.clientHeight - PAD }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    const a = anchor.current;
    const el = box.current;
    const im = img.current;
    anchor.current = null;
    if (!a || !el || !im) return;
    const r = im.getBoundingClientRect();
    el.scrollLeft += r.left + a.image.x * scale - a.at.x;
    el.scrollTop += r.top + a.image.y * scale - a.at.y;
  }, [scale]);

  // at: the client point that stays in place. The default is the center of the box.
  const set = (next: number | "fit", at?: Point) => {
    const el = box.current;
    const im = img.current;
    if (el && im && next !== "fit") {
      const b = el.getBoundingClientRect();
      const p = at ?? { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      const r = im.getBoundingClientRect();
      anchor.current = { at: p, image: { x: (p.x - r.left) / scale, y: (p.y - r.top) / scale } };
    }
    setZoom(next);
  };
  const latest = useRef(set);
  latest.current = set;
  const scaleNow = useRef(scale);
  scaleNow.current = scale;

  // React adds wheel listeners as passive, so preventDefault needs a native listener. Ctrl+wheel must not zoom the page.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const s = scaleNow.current;
      latest.current(e.deltaY < 0 ? zoomIn(s) : zoomOut(s), { x: e.clientX, y: e.clientY });
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, []);

  const keys = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const next =
      e.key === "+" || e.key === "="
        ? zoomIn(scale)
        : e.key === "-" || e.key === "_"
          ? zoomOut(scale)
          : e.key === "0"
            ? "fit"
            : e.key === "1"
              ? 1
              : null;
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    set(next);
  };

  const down = (e: PointerEvent<HTMLElement>) => {
    const el = box.current;
    if (e.button !== 0 || !el) return;
    el.setPointerCapture(e.pointerId);
    setDrag({ x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop });
  };
  const move = (e: PointerEvent<HTMLElement>) => {
    const el = box.current;
    if (!drag || !el) return;
    el.scrollLeft = drag.left - (e.clientX - drag.x);
    el.scrollTop = drag.top - (e.clientY - drag.y);
  };
  const up = () => setDrag(null);

  return (
    // The keys work anywhere in the dialog. The buttons inside keep Enter and Space.
    // biome-ignore lint/a11y/noStaticElementInteractions: the keys mirror the zoom buttons, which stay the accessible controls.
    <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-2" onKeyDown={keys}>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => set(zoomOut(scale))} disabled={scale <= ZOOM_MIN}>
          <ZoomOut data-icon="inline-start" />
          Zoom out
        </Button>
        <output aria-live="polite" aria-label="Zoom" data-zoom className="min-w-[3.5em] text-center font-mono text-sm tabular-nums">
          {zoomPercent(scale)}
        </output>
        <Button variant="outline" size="sm" onClick={() => set(zoomIn(scale))} disabled={scale >= ZOOM_MAX}>
          <ZoomIn data-icon="inline-start" />
          Zoom in
        </Button>
        <Button variant="outline" size="sm" aria-pressed={zoom === "fit"} onClick={() => set("fit")}>
          <Maximize data-icon="inline-start" />
          Fit
        </Button>
        <Button variant="outline" size="sm" aria-pressed={zoom === 1} onClick={() => set(1)}>
          100%
        </Button>
        <span className="text-xs text-muted-foreground">Keys: + − 0 (fit) 1 (100%). Ctrl+wheel zooms. Drag to pan.</span>
      </div>
      <section
        ref={box}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the box scrolls, so the arrow keys must reach it.
        tabIndex={0}
        aria-label={`Diagram view: ${title}`}
        className={cn(
          "min-h-0 touch-none overflow-auto rounded-md border bg-card outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/50",
          drag ? "cursor-grabbing" : "cursor-grab",
        )}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
      >
        <div className="grid min-h-full w-max min-w-full place-items-center p-3">
          <img
            ref={img}
            src={src}
            alt={`Diagram: ${title}`}
            draggable={false}
            className="block max-w-none"
            style={size ? { width: size.w * scale, height: size.h * scale } : undefined}
            onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          />
        </div>
      </section>
    </div>
  );
}

export function DiagramZoom(props: { src: string; title: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        data-diagram-zoom
        className="grid h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-none grid-rows-[auto_minmax(0,1fr)] gap-3 p-3 sm:max-w-none"
      >
        <div className="grid gap-0.5 pr-10">
          <DialogTitle className="truncate">Diagram: {props.title}</DialogTitle>
          <DialogDescription className="sr-only">A large view of the diagram with zoom controls.</DialogDescription>
        </div>
        <Viewer src={props.src} title={props.title} />
      </DialogContent>
    </Dialog>
  );
}
