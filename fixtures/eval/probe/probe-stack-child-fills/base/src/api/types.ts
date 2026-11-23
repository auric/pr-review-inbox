export type Request = { apiKey: string; path: string; now: number };
export type Reply = { status: number; headers: Record<string, string>; body: string };
export type Handler = (req: Request) => Reply;
