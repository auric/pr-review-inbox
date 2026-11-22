import { log } from "../log/logger";
import { redactHeaders } from "../log/redact";

// PUT /api/profile. The client sends the session token of the user as "Authorization: Bearer <token>".
export async function updateProfile(req: Request): Promise<Response> {
  let body: { displayName?: unknown };
  try {
    body = await req.json();
  } catch {
    log.warn("profile: the body is no JSON", { url: req.url, headers: redactHeaders(req.headers) });
    return new Response("Bad JSON", { status: 400 });
  }
  if (typeof body.displayName !== "string") return new Response("displayName is required", { status: 400 });
  return Response.json({ displayName: body.displayName.trim() });
}
