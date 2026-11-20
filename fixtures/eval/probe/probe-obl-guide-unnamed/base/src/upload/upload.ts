import { checkSize } from "./limits";

export async function upload(bytes: Uint8Array, send: (body: Uint8Array) => Promise<void>): Promise<void> {
  checkSize(bytes.length);
  await send(bytes);
}
