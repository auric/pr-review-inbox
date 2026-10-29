# Jira fixtures

Synthetic payloads for the fake Jira (`tests/support/fake-jira.ts`). No real server recorded them. Each file is a raw response body.

The shapes follow the response examples of the Jira Server platform REST API 9.12.0 docs (checked 2026-10-11): https://docs.atlassian.com/software/jira/docs/api/REST/9.12.0/

| File | Endpoint | Doc anchor |
|---|---|---|
| `myself.json` | `GET /rest/api/2/myself` | `#api/2/myself-getUser` |
| `issue.json` | `GET /rest/api/2/issue/{key}?fields=summary,description,status,attachment&expand=renderedFields` | `#api/2/issue-getIssue`; the status object follows `#api/2/status-getStatuses`; the attachment objects follow `#api/2/attachment-getAttachment` |
| `comments-p0.json` | `GET /rest/api/2/issue/{key}/comment?startAt=0&expand=renderedBody` | `#api/2/issue-getComments` |
| `comments-p1.json` | `GET /rest/api/2/issue/{key}/comment?startAt=2&expand=renderedBody` | `#api/2/issue-getComments` |
| `subtasks-odd.json` | `GET /rest/api/2/issue/ABC-10?fields=...,parent,subtasks,issuelinks` | `#api/2/issue-getIssue`; odd `subtasks`, `issuelinks`, and `parent` shapes for the lenient parse (spec.md section 6.20.9) |
| `subtasks-transitions-odd.json` | `GET /rest/api/2/issue/{key}/transitions` | `#api/2/issue-getTransitions`; odd entries for the lenient parse |

- The two comment pages hold `maxResults: 2`, so one issue needs two pages. The app asks for 100 per page. The server cap on `maxResults` is not documented.
- Host names use `example.test`. Names and texts are invented.
- The rendered HTML (plan r3 S-JMD) imitates the Jira wiki renderer: a heading with an anchor, a list, a table with a header row and a user mention, a `{code}` block with backticks inside, an external link, a `javascript:` link, an attachment thumbnail, and an emoticon. Links to Jira itself are root-relative, so they resolve against the fake Jira URL. The real HTML is not recorded (smoke E in docs/smoke-r3.md records the tag names).
- The `renderedBody` of the comment in `comments-p1.json` is a hostile sample: script, style, iframe, an image with `onerror`, and `](javascript:…)` in the text. The `*-CANARY` texts must never reach the output. The `javascript:` text stays plain text.
- Attachment bodies (plan r3 S-ATT): no body file is checked in. The fake makes each body at start and serves it at `/secure/attachment/<id>/<encoded filename>`, with the listed `mimeType` as Content-Type. `screenshot.png` (10100) is `pngOf(2048)`: an 8 x 8 PNG of one color, padded to the listed size with a `tEXt` chunk. `sync-worker.log` (10101) is `logOf(512)`: repeated ASCII log lines cut to the listed size. `attach()` adds a file to one issue for one test. Its listed size can differ from the body length, to test the size check.
- Replace these files with sanitized real payloads after the Release 2 and Release 3 smoke tests (docs/smoke-r2.md, docs/smoke-r3.md).
