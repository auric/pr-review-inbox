from functools import wraps

from flask import abort, g


def login_required(view):
    """Rejects a request with no signed-in user. The session middleware sets g.user from the session cookie."""

    @wraps(view)
    def wrapper(*args, **kwargs):
        if g.get("user") is None:
            abort(401)
        return view(*args, **kwargs)

    return wrapper


def require_role(role):
    """Rejects a signed-in user who does not have the role. Put it under login_required."""

    def decorate(view):
        @wraps(view)
        def wrapper(*args, **kwargs):
            if role not in g.user.roles:
                abort(403)
            return view(*args, **kwargs)

        return wrapper

    return decorate
