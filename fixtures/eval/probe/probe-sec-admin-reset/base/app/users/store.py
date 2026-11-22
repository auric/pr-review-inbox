"""User rows. Each user has an integer ID that counts up from 1."""

from dataclasses import dataclass, field


@dataclass
class User:
    id: int
    email: str
    roles: set[str] = field(default_factory=set)
    disabled: bool = False
    password_hash: str = ""
    must_change_password: bool = False


_users: dict[int, User] = {}


def get(user_id: int) -> User | None:
    return _users.get(user_id)


def set_disabled(user_id: int, disabled: bool) -> None:
    _users[user_id].disabled = disabled


def set_password(user_id: int, password_hash: str, must_change: bool) -> None:
    _users[user_id].password_hash = password_hash
    _users[user_id].must_change_password = must_change
