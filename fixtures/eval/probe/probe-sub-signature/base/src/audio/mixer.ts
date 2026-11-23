import { clamp } from "../../vendor/mathlib/src/clamp";

export const MIN_VOLUME = 0;
export const MAX_VOLUME = 100;

// The volume from a slider value.
export function volumeLevel(raw: number): number {
  return clamp(raw, MIN_VOLUME, MAX_VOLUME);
}
