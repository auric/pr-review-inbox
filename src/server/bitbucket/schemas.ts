// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Bitbucket Server REST 1.0 payloads. Only the used fields are parsed; zod strips the rest.
// Enum-like fields stay z.string(): real streams carry values beyond the documented ones.
import { z } from "zod";

// name: the username. X-AUSERNAME carries it.
export const user = z.object({ name: z.string(), slug: z.string(), displayName: z.string() });

const links = z.object({ self: z.array(z.object({ href: z.string() })).optional() }).optional();

// repository.links.self: the browse link (Gate v3 U5). A personal repository uses /users/<slug>/, so the app never builds it from the key.
// id: the full ref name, such as refs/heads/main. fromRef.repository is the fork for a PR from a fork.
const ref = z.object({
  id: z.string().optional(),
  displayId: z.string(),
  latestCommit: z.string(),
  repository: z.object({ slug: z.string(), project: z.object({ key: z.string() }), links }),
});

export const pullRequest = z.object({
  id: z.number(),
  version: z.number(),
  title: z.string(),
  description: z.string().optional(),
  state: z.string(),
  updatedDate: z.number(),
  // author.user.links.self: the user page (fixtures/bitbucket/pull-request.json).
  author: z.object({ user: user.extend({ links }) }),
  reviewers: z.array(z.object({ user, status: z.string(), lastReviewedCommit: z.string().optional() })),
  fromRef: ref,
  toRef: ref,
  links,
  // docs/plans/review-v2/spec.md section 6.18.5: fixtures/bitbucket/dashboard-pull-requests-page.json holds {"outcome": "CLEAN",
  // "current": true}. Another shape is no error: the PR then has no merge result.
  // mergeCommit: not in the docs schema, and Gate G17 found none on a merged PR. The app reads it only as the fallback of spec.md section
  // 6.16.10.
  properties: z
    .object({
      mergeResult: z.object({ outcome: z.string(), current: z.boolean() }).optional().catch(undefined),
      mergeCommit: z.object({ id: z.string() }).optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
});

const anchor = z.object({
  path: z.string(),
  line: z.number().optional(),
  lineType: z.string().optional(),
  fileType: z.string().optional(),
  diffType: z.string().optional(),
  fromHash: z.string().optional(),
  toHash: z.string().optional(),
  orphaned: z.boolean().optional(),
  // Gate A U2: a range comment adds these keys. line, lineType, and fileType then name the end line of the range.
  multilineMarker: z.object({ startLine: z.number(), startLineType: z.string() }).optional().catch(undefined),
  multilineSpan: z
    .object({ srcSpanStart: z.number(), srcSpanEnd: z.number(), dstSpanStart: z.number(), dstSpanEnd: z.number() })
    .optional()
    .catch(undefined),
});

export type RawComment = {
  id: number;
  version: number;
  text: string;
  author: z.infer<typeof user>;
  createdDate: number;
  updatedDate: number;
  threadResolved?: boolean;
  threadResolvedDate?: number | null;
  threadResolver?: z.infer<typeof user> | null;
  anchor?: z.infer<typeof anchor>;
  comments?: RawComment[];
  severity?: string;
  state?: string;
  resolvedDate?: number;
};

export const comment: z.ZodType<RawComment> = z.object({
  id: z.number(),
  version: z.number(),
  text: z.string(),
  author: user,
  createdDate: z.number(),
  updatedDate: z.number(),
  threadResolved: z.boolean().optional(),
  // The REST docs (Data Center 8.15) show both on a resolved thread. 9.4 is not verified (integration-check.md U56).
  // A bad value reads as absent, so it cannot fail the activities fetch. The user schema drops emailAddress.
  threadResolvedDate: z.number().nullish().catch(undefined),
  threadResolver: user.nullish().catch(undefined),
  anchor: anchor.optional(),
  comments: z.array(z.lazy(() => comment)).optional(),
  // Gate v3 U14: a task has severity BLOCKER. A resolve sets state RESOLVED and resolvedDate, raises the version, and adds no activity.
  severity: z.string().optional(),
  state: z.string().optional(),
  resolvedDate: z.number().optional(),
});

// POST .../comments returns the new comment with HTTP 201 (Gate 0). The outbox keeps only its ID and version.
export const postedComment = z.object({ id: z.number(), version: z.number() });

// The diff of an inline comment activity (I6). source and destination: the old and the new line number.
// commentIds: the comments on that row (Gate v3 fixtures). A value of another shape drops only the mark.
const diff = z.object({
  hunks: z.array(
    z.object({
      segments: z.array(
        z.object({
          type: z.string(),
          lines: z.array(
            z.object({
              source: z.number(),
              destination: z.number(),
              line: z.string(),
              commentIds: z.array(z.number()).optional().catch(undefined),
            }),
          ),
        }),
      ),
    }),
  ),
});
export type RawDiff = z.infer<typeof diff>;

export const activity = z.object({
  id: z.number(),
  action: z.string(),
  commentAction: z.string().optional(),
  comment: comment.optional(),
  // A diff in another shape only loses the excerpt. It must not fail the activities page.
  diff: diff.optional().catch(undefined),
  // Gate G17: the MERGED activity carries commit {id, parents, message}.
  commit: z.object({ id: z.string() }).optional().catch(undefined),
});

// PR commits page values (Gate v3 U15). An author without a forge account can lack slug and displayName.
export const commit = z.object({
  id: z.string(),
  author: z.object({ name: z.string(), slug: z.string().optional(), displayName: z.string().optional() }),
  authorTimestamp: z.number(),
  committerTimestamp: z.number(),
  message: z.string(),
  parents: z.array(z.object({ id: z.string() })),
});

// PR changes page values. srcPath: only for a moved or copied file.
const filePath = z.object({ toString: z.string() });
export const change = z.object({ path: filePath, srcPath: filePath.optional(), type: z.string() });

// GET /rest/build-status/1.0/commits/stats/{commit} (Gate G3). Data Center 9.x adds cancelled and unknown. Older servers can omit them.
export const buildStats = z.object({
  successful: z.number(),
  inProgress: z.number(),
  failed: z.number(),
  cancelled: z.number().optional().catch(undefined),
  unknown: z.number().optional().catch(undefined),
});

// GET .../default-branch (Gate G13): keys displayId, id, type. The id starts with refs/heads/.
export const defaultBranch = z.object({ id: z.string(), displayId: z.string() });

// GET .../branches values (Gate G14). The live flag key is isDefault. The Data Center 9.6 schema names it default.
export const branch = z.object({
  id: z.string(),
  displayId: z.string(),
  isDefault: z.boolean().optional().catch(undefined),
  default: z.boolean().optional().catch(undefined),
});

// GET .../projects/{p}/repos/{r} and the values of GET /rest/api/1.0/repos (Gate G16): project.key, slug, name, links.clone with http
// and ssh.
export const repository = z.object({
  slug: z.string(),
  name: z.string(),
  project: z.object({ key: z.string() }),
  links: z.object({ clone: z.array(z.object({ href: z.string(), name: z.string() })).optional() }).optional(),
});

// GET /rest/branch-permissions/latest/.../restrictions values (Data Center 9.6 REST): type, and the matcher with its id and type id.
export const restriction = z.object({
  type: z.string(),
  matcher: z.object({ id: z.string(), type: z.object({ id: z.string() }) }),
});

export const page = <T extends z.ZodType>(item: T) =>
  z.object({
    start: z.number(),
    isLastPage: z.boolean(),
    nextPageStart: z.number().nullish(),
    values: z.array(item),
  });
