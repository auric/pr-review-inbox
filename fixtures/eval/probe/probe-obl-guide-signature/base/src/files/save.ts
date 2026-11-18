import { joinPath } from "./paths";

export function reportPath(dir: string, day: string): string {
  return joinPath(dir, `report-${day}.txt`);
}
