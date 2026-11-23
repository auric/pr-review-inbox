import { parseQuota } from "../../vendor/configkit/src/quota";

// Whether a user may store one more file. setting is the QUOTA_FILES value of the plan.
export function canStore(setting: string, stored: number): boolean {
  const quota = parseQuota(setting);
  if (quota < 0) return true;
  return stored < quota;
}
