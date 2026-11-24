export type Order = { id: string; customerId: string; createdAt: number; total: number };

export interface Db {
  all<T>(sql: string, ...params: unknown[]): T[];
}
