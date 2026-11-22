import { importAvatar } from "../integrations/avatar-import";

// Any signed-in user can call each route. Bodies come from the client as typed.
export const routes: Record<string, (req: Request) => Promise<Response>> = {
  "POST /api/avatar/import": importAvatar,
};
