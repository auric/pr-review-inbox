// at: epoch time in ms. ms: the response time, or null when the probe lost the response.
export type Sample = { endpoint: string; at: number; ms: number | null };

export type Status = "ok" | "slow";

export type Row = { endpoint: string; averageMs: number; status: Status };
