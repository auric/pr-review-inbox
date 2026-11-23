import type { Handler, Reply, Request } from "./types";

export function serve(handler: Handler): (req: Request) => Reply {
  return (req) => handler(req);
}
