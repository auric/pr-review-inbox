import { audit } from "./log";
import type { Reply, SignupRequest } from "./types";
import { createUser } from "./users";

export async function signup(req: SignupRequest): Promise<Reply> {
  const user = await createUser(req.email, req.password);
  audit("signup.created", { email: req.email });
  return { status: 201, body: { id: user.id } };
}
