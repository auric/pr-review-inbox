// Scales a size in pixels by a factor and rounds it.
export function scale(size: number, factor: number): number {
  return Math.round(size * factor);
}
