// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Plan r3 S-JMD: Jira rendered HTML to Markdown. The HTML is untrusted.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fenced, toMarkdown } from "../../src/server/context/markdown";
import { taskFiles } from "../../src/server/context/task-file";
import { openDb } from "../../src/server/storage/db";
import type { IssueContext } from "../../src/shared/dto";
import { Markdown } from "../../src/web/pr/Markdown";
import { jiraFixture } from "../support/fake-jira";

const BASE = "https://jira.example.test";
const md = (html: string, base = BASE) => toMarkdown(html, base);
const render = (text: string, images?: (src: string) => string | null) => renderToStaticMarkup(createElement(Markdown, { text, images }));

const issue = jiraFixture<{ renderedFields: { description: string } }>("issue.json");
const hostile = jiraFixture<{ comments: { renderedBody: string }[] }>("comments-p1.json").comments[0]?.renderedBody ?? "";

describe("toMarkdown", () => {
  test("the fixture description: heading, list, table, code, links, mention, attachment, emoticon", () => {
    expect(md(issue.renderedFields.description)).toBe(
      [
        "The sync worker writes each cache entry on its own.",
        "",
        "### Acceptance criteria",
        "",
        "-   Batch the writes.",
        "-   Flush the cache before the write lock.",
        "",
        "| Step | Owner |",
        "| --- | --- |",
        "| Flush \\| now | Alex Smith |",
        "| Lock | sync worker |",
        "",
        "````",
        'String fence = "``` is not a fence";',
        "````",
        "",
        "See the [design note](https://docs.example.test/cache) and the old note. [![image 10100](attachment:10100)](https://jira.example.test/secure/attachment/10100/screenshot.png)",
      ].join("\n"),
    );
  });

  test("the hostile sample keeps no script, style, iframe, handler, remote image, or javascript: link", () => {
    const out = md(hostile);
    for (const canary of ["SCRIPT-CANARY", "STYLE-CANARY", "IFRAME-CANARY", "ONERROR-CANARY", "evil.example.test", "<script", "onerror"])
      expect(out).not.toContain(canary);
    expect(out).toBe("QA: test with an empty cache too.\n\nClick \\[here\\](javascript:alert(2)) now.");
    const html = render(out);
    for (const bad of ["<script", "<style", "<iframe", "<img", 'href="javascript:', "CANARY"]) expect(html).not.toContain(bad);
    expect(html).toContain("Click [here](javascript:alert(2)) now.");
  });

  test("each removed element goes with its content", () => {
    const content = [
      "script",
      "style",
      "iframe",
      "object",
      "form",
      "button",
      "select",
      "textarea",
      "noscript",
      "template",
      "video",
      "audio",
      "canvas",
    ];
    for (const tag of content) expect(md(`a<${tag}>${tag}-CANARY</${tag}>b`), tag).toBe("ab");
    expect(md("a<svg><text>SVG-CANARY</text></svg>b")).toBe("ab");
    expect(md("a<math><mi>MATH-CANARY</mi></math>b")).toBe("ab");
    expect(md("a<select><option>OPTION-CANARY</option></select>b")).toBe("ab");
    for (const tag of ["input", "embed", "link", "meta", "base"])
      expect(md(`a<${tag} value="X" href="https://evil.example.test/">b`), tag).toBe("ab");
  });

  test("a pre block gets a fence longer than any backtick run inside", () => {
    expect(md("<pre>a ```` b\n`c`</pre>")).toBe("`````\na ```` b\n`c`\n`````");
    expect(md("<pre><code>x &lt; y</code></pre>")).toBe("```\nx < y\n```");
    expect(md("<pre>\n\nline\n</pre>")).toBe("```\n\nline\n```");
  });

  test("tables: header cells, an empty header for a table without one, ragged rows, pipes, and breaks", () => {
    expect(md("<table><tr><td>a</td><td>b|c</td></tr><tr><td>d<br>e</td></tr></table>")).toBe(
      ["|  |  |", "| --- | --- |", "| a | b\\|c |", "| d e |  |"].join("\n"),
    );
    expect(md("<table><thead><tr><th>H</th></tr></thead><tbody><tr><td><b>x</b></td><td>y</td></tr></tbody></table>")).toBe(
      ["| H |  |", "| --- | --- |", "| **x** | y |"].join("\n"),
    );
    expect(md("<table><tr><td>a<table><tr><th>in</th></tr></table></td></tr></table>")).toBe(
      ["|  |", "| --- |", "| a \\| in \\| \\| --- \\| |"].join("\n"),
    );
    expect(md("<table></table>")).toBe("");
  });

  test("links: http(s) only, resolved against the base, mentions as plain names", () => {
    expect(md('<a href="https://x.example.test/a(1) b">t</a>')).toBe("[t](https://x.example.test/a\\(1\\)%20b)");
    expect(md('<a href="http://x.example.test/">t</a>')).toBe("[t](http://x.example.test/)");
    expect(md('<a href="/browse/ABC-1">ABC-1</a>', `${BASE}/jira`)).toBe("[ABC-1](https://jira.example.test/browse/ABC-1)");
    expect(md('<a href="browse/ABC-1">ABC-1</a>', `${BASE}/jira/`)).toBe("[ABC-1](https://jira.example.test/jira/browse/ABC-1)");
    for (const href of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "data:text/html,x",
      "mailto:a@example.test",
      "vbscript:x",
      "http://[bad",
    ])
      expect(md(`<a href="${href}">t</a>`), href).toBe("t");
    expect(md("<a>t</a> <a name=x></a>")).toBe("t");
    expect(md('<a href="https://x.example.test/"></a>')).toBe("");
    expect(md('<a href="/jira/secure/ViewProfile.jspa?name=asmith">Alex Smith</a>', `${BASE}/jira`)).toBe("Alex Smith");
    expect(md('<a href="https://other.example.test/secure/ViewProfile.jspa?name=a">A</a>')).toBe(
      "[A](https://other.example.test/secure/ViewProfile.jspa?name=a)",
    );
  });

  test("images: a Jira attachment or thumbnail under the base becomes a token; any other image becomes its alt text", () => {
    expect(md('<img src="/secure/attachment/10100/a.png" alt="a.png">')).toBe("![a.png](attachment:10100)");
    expect(md(`<img src="${BASE}/secure/thumbnail/10100/_thumb_10100.png">`)).toBe("![image 10100](attachment:10100)");
    expect(md('<img src="/jira/secure/attachment/7/x.png" title="x]y">', `${BASE}/jira`)).toBe("![x\\]y](attachment:7)");
    expect(md('<img src="/secure/attachment/7/x.png" alt="x">', `${BASE}/jira`)).toBe("x");
    expect(md('<img src="https://other.example.test/secure/attachment/7/x.png" alt="x">')).toBe("x");
    expect(md('<img src="/secure/attachment/1234567890123456789/x.png" alt="x">')).toBe("x");
    expect(md('<img src="/images/icons/emoticons/smile.png" alt="">')).toBe("");
    expect(md('<img src="https://evil.example.test/p.png" alt="[a](javascript:x)">')).toBe("\\[a\\](javascript:x)");
  });

  test("text cannot start raw HTML, an entity, a link, or emphasis", () => {
    expect(md("<p>List&lt;String&gt; &amp;amp; [x](javascript:y) *b* 1. a</p>")).toBe(
      "List\\<String> \\&amp; \\[x\\](javascript:y) \\*b\\* 1. a",
    );
    expect(render(md("<p>List&lt;String&gt; &amp;copy;</p>"))).toBe('<div class="rl-md"><p>List&lt;String&gt; &amp;copy;</p></div>');
  });
});

describe("fenced", () => {
  test("the fence is longer than every backtick run, and CRLF becomes LF", () => {
    expect(fenced("a\r\nb\r\n")).toBe("```\na\nb\n```");
    expect(fenced("x ``` y ````` z")).toBe("``````\nx ``` y ````` z\n``````");
  });
});

describe("Markdown component", () => {
  const text = "a ![shot.png](attachment:10100) b ![r](https://x.example.test/r.png)";

  test("without images: an attachment shows its alt text, a remote image is a link, and no img renders", () => {
    const html = render(text);
    expect(html).not.toContain("<img");
    expect(html).toContain("<span>shot.png</span>");
    expect(html).toContain('<a href="https://x.example.test/r.png" target="_blank" rel="noopener noreferrer">r</a>');
  });

  test("with images: a resolved source renders an img, null renders the alt text", () => {
    const seen: string[] = [];
    const html = render(text, (src) => {
      seen.push(src);
      return src === "attachment:10100" ? "/api/local/10100" : null;
    });
    expect(seen).toEqual(["attachment:10100", "https://x.example.test/r.png"]);
    expect(html).toContain('<img src="/api/local/10100" alt="shot.png" loading="lazy"/>');
    expect(html).toContain("<span>r</span>");
    expect(html).not.toContain("x.example.test");
  });

  test("attachment: stays an image source only", () => {
    expect(render("[l](attachment:1)")).toBe('<div class="rl-md"><p>l</p></div>');
  });

  test("GFM: a table in its scroll box, strikethrough, and a task list", () => {
    const html = render("| A | B \\| C |\n| :-- | --: |\n| **1** | 2 |\n\n~~old~~\n\n- [x] done\n- [ ] open");
    expect(html).toContain(
      '<div class="rl-md-table"><table><thead><tr><th style="text-align:left">A</th><th style="text-align:right">B | C</th></tr></thead>' +
        '<tbody><tr><td style="text-align:left"><strong>1</strong></td><td style="text-align:right">2</td></tr></tbody></table></div>',
    );
    expect(html).toContain("<del>old</del>");
    expect(html).toContain('<li class="task-list-item"><input type="checkbox" disabled="" aria-label="done" checked=""/> done</li>');
  });

  test("links: only http(s) and in-page links; GFM autolinks and footnotes make no other scheme", () => {
    const html = render(
      [
        "a@example.test www.example.test https://x.example.test/p mailto:b@example.test xmpp:c@example.test",
        "[m](mailto:d@example.test) [i](irc://e.example.test) [j](javascript:alert(1)) [r](/rel)",
        "",
        "Note[^1]",
        "",
        "[^1]: [f](ftp://f.example.test) and <mailto:g@example.test>",
      ].join("\n"),
    );
    const hrefs = [...html.matchAll(/<a [^>]*>/g)].map((m) => m[0]);
    expect(hrefs).toEqual([
      '<a href="http://www.example.test" target="_blank" rel="noopener noreferrer">',
      '<a href="https://x.example.test/p" target="_blank" rel="noopener noreferrer">',
      '<a href="/rel" target="_blank" rel="noopener noreferrer">',
      '<a href="#user-content-fn-1" id="user-content-fnref-1" data-footnote-ref="true" aria-describedby="footnote-label">',
      '<a href="#user-content-fnref-1" data-footnote-backref="" aria-label="Back to reference 1" class="data-footnote-backref">',
    ]);
    for (const text of ["a@example.test", "b@example.test", "c@example.test", "m", "i", "j", "f", "g@example.test"])
      expect(html).toContain(text);
  });
});

describe("task.md", () => {
  const root = mkdtempSync(join(tmpdir(), "rl-md-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("a Markdown row names images as text; a plain row stays as stored", () => {
    const db = openDb(join(root, "t.sqlite"));
    try {
      const pr = (db.query("INSERT INTO pull_request (project, repo, pr_id) VALUES ('P', 'r', 1) RETURNING id").get() as { id: number }).id;
      const row = (key: string, i: Partial<IssueContext>) =>
        db.query("INSERT INTO task_context (pr, key, source, json, fetched_at) VALUES ($pr, $key, 'jira', $json, 0)").run({
          pr,
          key,
          json: JSON.stringify({ key, summary: key, status: null, comments: [], commentsTotal: 0, truncated: false, ...i }),
        });
      const image = "See ![a\\]b.png](attachment:10100) and ![c](attachment:7).";
      row("ABC-1", { description: image, format: "markdown", comments: [{ author: "A", created: "C", body: image }], commentsTotal: 1 });
      row("ABC-2", { description: image });
      const [one, two] = (taskFiles(db, pr)[0]?.text ?? "").split("## Task ABC-2");
      expect(one?.split("See (image: a\\]b.png) and (image: c).").length).toBe(3);
      expect(one).not.toContain("attachment:");
      expect(two).toContain(image);
    } finally {
      db.close();
    }
  });
});
