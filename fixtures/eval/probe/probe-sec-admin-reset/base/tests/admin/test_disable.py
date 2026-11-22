from app.users import store


def test_admin_disables_a_user(admin_client):
    store._users[5] = store.User(id=5, email="user5@example.invalid")
    assert admin_client.post("/admin/users/5/disable").status_code == 200
    assert store.get(5).disabled


def test_a_user_without_the_admin_role_gets_403(user_client):
    store._users[6] = store.User(id=6, email="user6@example.invalid")
    assert user_client.post("/admin/users/6/disable").status_code == 403
    assert not store.get(6).disabled
