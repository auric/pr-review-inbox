import { isAllowedUrl } from "../net/allow";

// POST /api/avatar/import with the JSON body { url }. The user types the URL.
export async function importAvatar(req: Request): Promise<Response> {
  const { url } = (await req.json().catch(() => ({}))) as { url?: unknown };
  if (typeof url !== "string" || !isAllowedUrl(url)) return new Response("URL not allowed", { status: 400 });
  const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(5000) });
  if (!res.ok) return new Response("Fetch failed", { status: 502 });
  return new Response(await res.arrayBuffer(), { headers: { "Content-Type": "image/png" } });
}
