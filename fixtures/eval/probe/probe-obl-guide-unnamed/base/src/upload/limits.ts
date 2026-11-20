export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export function checkSize(bytes: number): void {
  if (bytes > MAX_UPLOAD_BYTES) throw new RangeError("The file is too large.");
}
