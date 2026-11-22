"""Order queries. A value from a request goes in as a ? parameter, never into the SQL text."""

import sqlite3


def get_order(conn: sqlite3.Connection, customer_id: int, order_id: int):
    return conn.execute(
        "SELECT id, status, total_cents FROM orders WHERE customer_id = ? AND id = ?",
        (customer_id, order_id),
    ).fetchone()


def count_by_status(conn: sqlite3.Connection, customer_id: int, status: str) -> int:
    row = conn.execute(
        "SELECT COUNT(*) FROM orders WHERE customer_id = ? AND status = ?",
        (customer_id, status),
    ).fetchone()
    return row[0]
