import type { Env } from "../config/env";

export const DEFAULT_QUOTA = 1000;

// The number of requests that one API key can make per day.
export function dailyQuota(_env: Env): number {
  return DEFAULT_QUOTA;
}

export function allowRequest(env: Env, used: number): boolean {
  return used < dailyQuota(env);
}
