// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Web links into the forge (plan v3 WP4, WP13b). Each base is a server link that passed the origin check (Gate v3 U5).
// A personal repository uses /users/<slug>/, so no link is built from the project key.
// ponytail: the suffixes "?at=<hash>#<line>" and "/overview?commentId=<id>" are not verified on a real server (Gate v3 U5).
// Verify both in the browser, then remove this note.

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
// A token or a task link must not travel in clear text. Plain http is for this machine only.
export const secureUrl = (u: URL) => u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK.has(u.hostname));

// Parentheses close a Markdown link target, so they are encoded too.
const segment = (s: string) => encodeURIComponent(s).replace(/\(/g, "%28").replace(/\)/g, "%29");

// repoUrl: the repository browse link. at: the commit hash that holds the line.
export const fileUrl = (repoUrl: string, path: string, at: string, line: number) =>
  `${repoUrl.replace(/\/+$/, "")}/${path.split("/").map(segment).join("/")}?at=${encodeURIComponent(at)}#${line}`;

// prUrl: the PR link (PR links.self).
export const commentUrl = (prUrl: string, id: number) => `${prUrl.replace(/\/+$/, "")}/overview?commentId=${id}`;
