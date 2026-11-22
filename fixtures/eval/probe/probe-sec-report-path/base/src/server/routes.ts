import { serveAvatar } from "../files/avatars";

// Any signed-in user can call each route. Path and query values come from the client as typed.
export const routes: Record<string, (req: Request) => Promise<Response>> = {
  "GET /files/avatar": serveAvatar,
};
