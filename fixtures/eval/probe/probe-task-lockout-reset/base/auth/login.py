from auth.passwords import check_password


class LoginError(Exception):
    pass


def start_session(user):
    return {"user": user.name}


def login(account, password, users):
    user = users.get(account)
    if user is None or not check_password(user, password):
        raise LoginError("bad credentials")
    return start_session(user)
