import pytest
from flask import Flask, g

from app.admin.routes import bp
from app.users import store


def _client(roles):
    app = Flask(__name__)
    app.register_blueprint(bp)

    @app.before_request
    def sign_in():
        g.user = store.User(id=1, email="signed-in@example.invalid", roles=roles)

    return app.test_client()


@pytest.fixture
def admin_client():
    return _client({"admin"})


@pytest.fixture
def user_client():
    return _client(set())
