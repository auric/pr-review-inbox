// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// A ```mermaid block as an image with "Zoom", "Show code", and "Copy code" (plan review-v2 spec 3.1). The image and Zoom open the large
// view. A block that does not render shows its code.
import { Braces, CircleAlert, Copy, ZoomIn } from "lucide-react";
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { toast } from "@/components/ui/toast";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { useDark } from "../theme";
import { DiagramZoom } from "./DiagramZoom";
import { prepare, type Rendered, renderDiagram, themeVariables } from "./mermaid";

const icon = "size-[15px] shrink-0";
const action = "rl-hit inline-flex cursor-pointer items-center gap-1 rounded text-sm font-medium text-pen hover:underline";

function Note({ error, children }: { error?: boolean; children: ReactNode }) {
  return (
    <p className={cn("m-0 flex items-start gap-1.5 text-sm", error ? "text-destructive" : "text-muted-foreground")}>
      {error && <CircleAlert aria-hidden className={cn(icon, "mt-0.5")} />}
      <span className="min-w-0">{children}</span>
    </p>
  );
}

export function Diagram({ code }: { code: string }) {
  const prepared = useMemo(() => prepare(code), [code]);
  const dark = useDark();
  const [out, setOut] = useState<Rendered | null>(null);
  const [show, setShow] = useState(false);
  const [zoom, setZoom] = useState(false);
  const pre = useRef<HTMLPreElement>(null);
  const codeId = useId();

  // A theme change renders again. The old image stays until the new one is ready.
  useEffect(() => {
    if (!prepared.ok) return;
    let live = true;
    void renderDiagram(prepared.code, themeVariables(dark)).then((r) => {
      if (live) setOut(r);
    });
    return () => {
      live = false;
    };
  }, [prepared, dark]);

  // A blocked clipboard shows the code and selects it.
  const copy = () =>
    void copyText(code).then((ok) => {
      if (ok) {
        toast.add({ title: "Copied the diagram code." });
        return;
      }
      flushSync(() => setShow(true));
      if (!pre.current) return;
      const r = document.createRange();
      r.selectNodeContents(pre.current);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(r);
      toast.add({ title: "The clipboard is blocked here. The code is selected: press Ctrl+C to copy it." });
    });

  const src = prepared.ok && out?.ok ? out.src : null;
  let note: ReactNode = null;
  if (!prepared.ok)
    note = (
      <Note>
        {prepared.reason === "long"
          ? "This diagram has more than 20,000 characters, so it shows as code."
          : "Only flowchart, sequence, and class diagrams show as pictures. This one shows as code."}
      </Note>
    );
  else if (out && !out.ok) note = <Note error>The diagram did not render: {out.error}</Note>;

  return (
    <figure data-diagram={src ? "image" : note ? "code" : "drawing"} className="m-0 mb-2 grid justify-items-start gap-1.5">
      {src && prepared.ok && (
        <>
          <button
            type="button"
            aria-label={`Open diagram: ${prepared.title}`}
            className="rl-fade max-w-full cursor-zoom-in rounded-md border bg-card p-3 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            onClick={() => setZoom(true)}
          >
            <img src={src} alt={`Diagram: ${prepared.title}`} className="block h-auto max-w-full" />
          </button>
          <DiagramZoom src={src} title={prepared.title} open={zoom} onOpenChange={setZoom} />
        </>
      )}
      {(!src || show) && (
        <pre id={codeId} ref={pre} className="m-0 justify-self-stretch">
          <code>{code}</code>
        </pre>
      )}
      {note}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {src && (
          <button type="button" className={action} aria-haspopup="dialog" onClick={() => setZoom(true)}>
            <ZoomIn aria-hidden className={icon} />
            Zoom
          </button>
        )}
        {src && (
          <button type="button" className={action} aria-expanded={show} aria-controls={codeId} onClick={() => setShow((s) => !s)}>
            <Braces aria-hidden className={icon} />
            {show ? "Hide code" : "Show code"}
          </button>
        )}
        <button type="button" className={action} onClick={copy}>
          <Copy aria-hidden className={icon} />
          Copy code
        </button>
      </div>
    </figure>
  );
}
