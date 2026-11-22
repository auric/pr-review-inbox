// Header names whose values are credentials. A log line must never show them.
const SECRET_HEADERS = new Set(["authorization", "cookie", "x-api-key"]);

export function redactHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    out[name] = SECRET_HEADERS.has(name.toLowerCase()) ? "[redacted]" : value;
  });
  return out;
}
