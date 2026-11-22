import logging

from flask import Blueprint, g, jsonify

from app.auth import login_required, require_role
from app.users import store

log = logging.getLogger(__name__)
bp = Blueprint("admin", __name__, url_prefix="/admin")


# Every signed-in user can reach this blueprint. Only require_role("admin") keeps a route for admins.
@bp.post("/users/<int:user_id>/disable")
@login_required
@require_role("admin")
def disable_user(user_id):
    if store.get(user_id) is None:
        return jsonify(error="no such user"), 404
    store.set_disabled(user_id, True)
    log.info("user %s disabled by %s", user_id, g.user.id)
    return jsonify(ok=True)


@bp.post("/users/<int:user_id>/enable")
@login_required
@require_role("admin")
def enable_user(user_id):
    if store.get(user_id) is None:
        return jsonify(error="no such user"), 404
    store.set_disabled(user_id, False)
    log.info("user %s enabled by %s", user_id, g.user.id)
    return jsonify(ok=True)
