from flask import Blueprint, g, jsonify, request

from app.db import orders

# The session middleware sets g.user and g.db. Query values come from the client as typed.
bp = Blueprint("orders", __name__)


@bp.get("/orders/<int:order_id>")
def show(order_id):
    row = orders.get_order(g.db, g.user.id, order_id)
    if row is None:
        return jsonify(error="no such order"), 404
    return jsonify(dict(row))


@bp.get("/orders/count")
def count():
    status = request.args.get("status", "open")
    return jsonify(count=orders.count_by_status(g.db, g.user.id, status))
