import { readFile } from "node:fs/promises";
import { UPLOAD_ROOT } from "../config";
import { resolveInside } from "./safe-path";

// GET /files/avatar?name=<file>. The name comes from the query string of the client, as typed.
export async function serveAvatar(req: Request): Promise<Response> {
  const name = new URL(req.url).searchParams.get("name");
  if (!name) return new Response("name is required", { status: 400 });
  const file = resolveInside(UPLOAD_ROOT, `avatars/${name}`);
  if (!file) return new Response("Not found", { status: 404 });
  try {
    return new Response(await readFile(file), { headers: { "Content-Type": "image/png" } });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
