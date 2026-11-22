import { ALLOWED_FETCH_HOSTS } from "../config";

// The server fetches a URL from a request only when this returns true.
// It keeps the server off internal hosts and the cloud metadata address 169.254.169.254.
export function isAllowedUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return url.protocol === "https:" && ALLOWED_FETCH_HOSTS.includes(url.hostname);
}
