import { parseQuota } from "../../vendor/configkit/src/quota";

// The quota text for the plan page.
export function quotaLabel(setting: string): string {
  if (setting === "unlimited") return "No limit";
  return `${parseQuota(setting)} files`;
}
