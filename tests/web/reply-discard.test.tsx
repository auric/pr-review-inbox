// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The reply confirm offers to discard the AI reply draft that the user's own reply puts out of date. Pure rules and static markup.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReviewItemDto } from "../../src/shared/dto";
import type { ReplyPayload } from "../../src/shared/review";
import { aiReplyDraft } from "../../src/web/review/model";

// src/web/api.ts reads the session token from the page when it loads. The components import it, so they load under this stub.
// The stub goes after the load, because the test files share one global object.
const g = globalThis as { document?: unknown };
const stub = g.document === undefined;
if (stub) g.document = { querySelector: () => null };
const { DropDraftBox } = await import("../../src/web/pr/ReplyComposer");
const { Confirm } = await import("../../src/web/publish/Confirm");
if (stub) delete g.document;

console.log(`reply-discard.test.tsx imported from ${Bun.resolveSync("../../src/web/review/model", import.meta.dir)}`);

const NEWEST = 500;
const reply = (p: Partial<ReplyPayload> = {}, o: Partial<ReviewItemDto> = {}): ReviewItemDto => {
  const body = o.body ?? "Thanks.";
  return {
    id: 7,
    run: 40,
    kind: "reply",
    body,
    payload: {
      thread: 100,
      action: body ? "reply" : "none",
      body,
      reason: "r",
      evidenceStatus: "code",
      replyTo: NEWEST,
      origin: "reply",
      ...p,
    },
    anchor: null,
    status: "new",
    revision: 1,
    edited: false,
    ...o,
  };
};

describe("aiReplyDraft", () => {
  test("a current AI draft, new or accepted, of any AI origin or of no origin", () => {
    for (const origin of ["review", "reply", "fix", "nofix", "session", "resolve", "discuss", undefined] as const) {
      const it = reply({ origin });
      expect(aiReplyDraft(it, NEWEST)).toBe(it);
    }
    const accepted = reply({}, { status: "accepted" });
    expect(aiReplyDraft(accepted, NEWEST)).toBe(accepted);
  });
  test("no draft for a user draft, an out-of-date draft, a discarded or posted draft, or a draft without text", () => {
    expect(aiReplyDraft(undefined, NEWEST)).toBeNull();
    expect(aiReplyDraft(reply({ origin: "user" }), NEWEST)).toBeNull();
    expect(aiReplyDraft(reply({ replyTo: NEWEST - 1 }), NEWEST)).toBeNull();
    expect(aiReplyDraft(reply({}, { status: "discarded" }), NEWEST)).toBeNull();
    expect(aiReplyDraft(reply({}, { status: "posted" }), NEWEST)).toBeNull();
    expect(aiReplyDraft(reply({}, { body: "" }), NEWEST)).toBeNull();
  });
});

describe("the reply confirm", () => {
  const html = (checked: boolean, posting = false) =>
    renderToStaticMarkup(
      <Confirm
        id="rcc-1"
        title="Post this reply to Alex?"
        note="Note."
        entries={[]}
        posting={posting}
        error={null}
        canPost
        onPost={() => {}}
        onCancel={() => {}}
        extra={<DropDraftBox runner="Claude" checked={checked} disabled={posting} onChange={() => {}} />}
      />,
    );
  test("shows the checked box with its text above Post", () => {
    const out = html(true);
    expect(out).toContain("Also discard Claude&#x27;s draft reply in this thread");
    expect(out).toMatch(/<label data-drop-draft[^>]*><input type="checkbox"[^>]*checked=""/);
    expect(out.indexOf("data-drop-draft")).toBeLessThan(out.indexOf(">Post<"));
  });
  test("an unchecked box has no checked attribute, and the box is off while the reply posts", () => {
    expect(html(false)).not.toMatch(/checked=""/);
    expect(html(true, true)).toMatch(/<input type="checkbox"[^>]*disabled=""/);
  });
});
