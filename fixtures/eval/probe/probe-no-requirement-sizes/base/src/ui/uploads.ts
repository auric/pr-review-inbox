export type Upload = { name: string; bytes: number };

export function uploadRows(uploads: readonly Upload[]): string[] {
  return uploads.map((u) => u.name);
}
