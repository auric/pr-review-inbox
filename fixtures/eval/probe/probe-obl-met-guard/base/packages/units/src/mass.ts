const POUNDS_PER_KILOGRAM = 2.20462;

export function toKilograms(pounds: number): number {
  return pounds / POUNDS_PER_KILOGRAM;
}
