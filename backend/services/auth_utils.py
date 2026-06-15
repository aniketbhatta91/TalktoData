"""Auth utilities: password hashing (PBKDF2 via stdlib) + JWT (PyJWT).
No compiled C extensions required — works on any platform out of the box.
"""
import hashlib
import hmac
import os
from datetime import datetime, timedelta, timezone

import jwt

import config

TOKEN_EXPIRE_DAYS = 7
_ITERATIONS = 260_000


def hash_password(password: str) -> str:
    """Return a salted PBKDF2-SHA256 hash as  salt$hash  (hex encoded)."""
    salt = os.urandom(16).hex()
    h = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), _ITERATIONS)
    return f"{salt}${h.hex()}"


def verify_password(plain: str, stored: str) -> bool:
    """Constant-time comparison against a stored salt$hash string."""
    try:
        salt, stored_hash = stored.split("$", 1)
    except ValueError:
        return False
    h = hashlib.pbkdf2_hmac("sha256", plain.encode(), salt.encode(), _ITERATIONS)
    return hmac.compare_digest(h.hex(), stored_hash)


def create_token(user_id: int, email: str, role: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(days=TOKEN_EXPIRE_DAYS)
    payload = {"sub": str(user_id), "email": email, "role": role, "exp": expire}
    return jwt.encode(payload, config.JWT_SECRET, algorithm="HS256")


def decode_token(token: str) -> dict | None:
    try:
        return jwt.decode(token, config.JWT_SECRET, algorithms=["HS256"])
    except jwt.PyJWTError:
        return None
