import hashlib
import hmac


def hash_password(password: str, salt: bytes) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 600_000)


def check_password(user, password: str) -> bool:
    return hmac.compare_digest(hash_password(password, user.salt), user.password_hash)
