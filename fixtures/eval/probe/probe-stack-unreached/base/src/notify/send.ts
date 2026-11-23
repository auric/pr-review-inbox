export type Send = () => Promise<boolean>;

// Sends one notification. It gives true when the receiver accepted it.
export async function deliver(send: Send): Promise<boolean> {
  return send();
}
