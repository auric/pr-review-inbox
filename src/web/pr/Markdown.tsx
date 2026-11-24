// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Safe Markdown (BRIEF 3.6): no raw HTML, no remote images, links only for http(s). A diff: link of the Explain page is a button.
// GFM adds tables, task lists, strikethrough, and autolinks.
import { lazy, Suspense, useMemo } from "react";
import ReactMarkdown, { type Components, defaultUrlTransform, type ExtraProps, type UrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

const external = { target: "_blank", rel: "noopener noreferrer" } as const;
// The image source of a task attachment (plan r3 S-JMD): attachment:<id>.
const ATTACHMENT = "attachment:";
const plugins = [remarkGfm];

type HastNode = NonNullable<ExtraProps["node"]>["children"][number];
// The text of a node without its nested lists.
const ownText = (n: HastNode): string =>
  n.type === "text" ? n.value : n.type === "element" && n.tagName !== "ul" && n.tagName !== "ol" ? n.children.map(ownText).join("") : "";
// A GFM task list box has no label. It gets the text of its item as its name. A loose list puts the box in a <p>.
function taskBoxNames() {
  const walk = (n: HastNode | { type: "root"; children: HastNode[] }) => {
    if (n.type !== "element" && n.type !== "root") return;
    if (n.type === "element" && n.tagName === "li") {
      const first = n.children.find((c) => c.type === "element");
      const box = first?.type === "element" && first.tagName === "p" ? first.children.find((c) => c.type === "element") : first;
      if (box?.type === "element" && box.tagName === "input" && box.properties.type === "checkbox")
        box.properties.ariaLabel = n.children.map(ownText).join("").replace(/\s+/g, " ").trim();
    }
    for (const c of n.children) walk(c);
  };
  return walk;
}
const rehype = [taskBoxNames];
// The diagram code loads on the first ```mermaid block. The block shows as code until then.
const Diagram = lazy(() => import("../explain/Diagram").then((m) => ({ default: m.Diagram })));

// The text of a ```mermaid block, or null for another element.
function mermaidCode(pre: ExtraProps["node"]): string | null {
  const code = pre?.children[0];
  if (code?.type !== "element" || code.tagName !== "code") return null;
  const cls = code.properties.className;
  if (!Array.isArray(cls) || !cls.includes("language-mermaid")) return null;
  return code.children.map((c) => (c.type === "text" ? c.value : "")).join("");
}

// The default keeps mailto:, xmpp:, and irc(s):, and GFM makes them from plain addresses. A URL with a scheme stays only for http(s).
const urlTransform: UrlTransform = (url, key) => {
  if (key === "src" && url.startsWith(ATTACHMENT)) return url;
  const safe = defaultUrlTransform(url);
  return /^[^/?#]*:/.test(safe) && !/^https?:/i.test(safe) ? "" : safe;
};
// docs/plans/review-v2/spec.md section 3.5: a diff: link stays only for a text with links. It never reaches an href.
const DIFF = "diff:";
const diffTransform: UrlTransform = (url, key, node) => (key === "href" && url.startsWith(DIFF) ? url : urlTransform(url, key, node));
const diffLink = "rl-hit inline cursor-pointer rounded text-left text-pen underline underline-offset-2 hover:decoration-2";

// images: maps an image source to a local URL; null shows the alt text. Without it, an image is a link and an attachment shows its alt text.
// Pass a stable images function: a new one remounts the rendered images.
// diagrams: a ```mermaid block shows as a diagram (src/web/explain/mermaid.ts). Only for text that the AI wrote for the user.
// links: the action of a diff: link (src/web/explain/links.ts), or null for a link that the page cannot open. Such a link and every
// diff: link without links show as their text. Pass a stable links function, as for images.
export function Markdown({
  text,
  images,
  diagrams,
  links,
}: {
  text: string;
  images?: (src: string) => string | null;
  diagrams?: boolean;
  links?: (href: string) => (() => void) | null;
}) {
  const components = useMemo<Components>(
    () => ({
      pre: ({ node, ...props }) => {
        const code = diagrams ? mermaidCode(node) : null;
        return code === null ? (
          <pre {...props} />
        ) : (
          <Suspense
            fallback={
              <pre>
                <code>{code}</code>
              </pre>
            }
          >
            <Diagram code={code} />
          </Suspense>
        );
      },
      // A dropped URL leaves the text. A footnote link stays in the page.
      a: ({ node: _, ...props }) => {
        if (!props.href) return props.children;
        if (props.href.startsWith(DIFF)) {
          const go = links?.(props.href) ?? null;
          return go ? (
            <button type="button" data-diff-link className={diffLink} onClick={go}>
              {props.children}
            </button>
          ) : (
            props.children
          );
        }
        return <a {...props} {...(props.href.startsWith("#") ? {} : external)} />;
      },
      img: ({ src, alt }) => {
        if (typeof src !== "string" || !src) return <span>{alt}</span>;
        if (!images && !src.startsWith(ATTACHMENT))
          return (
            <a href={src} {...external}>
              {alt || src}
            </a>
          );
        const local = images?.(src) ?? null;
        // Lazy: an image in a closed fold loads only when the fold opens.
        return local ? <img src={local} alt={alt ?? ""} loading="lazy" /> : <span>{alt}</span>;
      },
      // A wide table scrolls in its own box, so it never widens the pane.
      table: ({ node: _, ...props }) => (
        <div className="rl-md-table">
          <table {...props} />
        </div>
      ),
    }),
    [images, diagrams, links],
  );
  return (
    <div className="rl-md">
      <ReactMarkdown
        skipHtml
        remarkPlugins={plugins}
        rehypePlugins={rehype}
        components={components}
        urlTransform={links ? diffTransform : urlTransform}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
