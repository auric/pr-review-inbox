export function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

export function isDay(text: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(text);
}
