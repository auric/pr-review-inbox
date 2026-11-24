// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../../src/web/pr/Markdown";

test("Markdown drops raw HTML, turns images into links, and opens links in a new tab", () => {
  const html = renderToStaticMarkup(
    <Markdown
      text={
        '<img src="https://x.test/a.png" onerror="alert(1)"> **b** [l](https://x.test/p) ![pic](https://x.test/i.png) [j](javascript:alert(1))'
      }
    />,
  );
  expect(html).not.toContain("<img");
  expect(html).not.toContain("onerror");
  expect(html).toContain("<strong>b</strong>");
  expect(html).toContain('<a href="https://x.test/p" target="_blank" rel="noopener noreferrer">l</a>');
  expect(html).toContain('<a href="https://x.test/i.png" target="_blank" rel="noopener noreferrer">pic</a>');
  expect(html).not.toContain("javascript:");
});

const FENCES = "```mermaid\ngraph TD\n  A --> B\n```\n\n```ts\nconst a = 1;\n```";

test("A mermaid block stays code without diagrams", () => {
  const html = renderToStaticMarkup(<Markdown text={FENCES} />);
  expect(html).toContain('<pre><code class="language-mermaid">graph TD\n  A --&gt; B\n</code></pre>');
  expect(html).toContain('<pre><code class="language-ts">');
});

// The diagram module loads lazily, so a static render shows the code until then. Other code blocks do not change.
test("With diagrams, a mermaid block shows its code until the diagram loads", () => {
  const html = renderToStaticMarkup(<Markdown text={FENCES} diagrams />);
  expect(html).toContain("<pre><code>graph TD\n  A --&gt; B\n</code></pre>");
  expect(html).not.toContain("language-mermaid");
  expect(html).toContain('<pre><code class="language-ts">');
});

// axe "label": a task list box needs a name. It gets the text of its item without the nested list.
test("A task list box gets the text of its item as its name", () => {
  const html = renderToStaticMarkup(<Markdown text={"- [x] Take the **lock**\n  - [ ] Inner step\n- [ ] Loose\n\n  More text"} />);
  expect(html).toContain('aria-label="Take the lock"');
  expect(html).toContain('aria-label="Inner step"');
  expect(html).toContain('aria-label="Loose More text"');
  expect(html.match(/type="checkbox"/g)?.length).toBe(3);
  expect(html.match(/aria-label=/g)?.length).toBe(3);
});
