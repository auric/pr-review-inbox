import { canonicalEmail } from "./email";

export type User = { id: number; email: string; name: string };

export class UserRepo {
  private readonly rows: User[] = [];
  private next = 1;

  insert(u: Omit<User, "id">): User {
    const row = { ...u, email: canonicalEmail(u.email), id: this.next++ };
    this.rows.push(row);
    return { ...row };
  }

  findByEmail(email: string): User | undefined {
    const key = canonicalEmail(email);
    const row = this.rows.find((r) => r.email === key);
    return row && { ...row };
  }
}
