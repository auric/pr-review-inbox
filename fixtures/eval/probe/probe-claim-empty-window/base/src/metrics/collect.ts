import type { Sample } from "./types";

// The samples of one endpoint from `since` on, oldest first. An endpoint without traffic in the window gives an empty list.
export function collect(all: readonly Sample[], endpoint: string, since: number): Sample[] {
  return all.filter((s) => s.endpoint === endpoint && s.at >= since).sort((a, b) => a.at - b.at);
}
