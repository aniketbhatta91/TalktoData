"""Auth utilities: password hashing (bcrypt) + JWT create/decode."""
from datetime import datetime, timedelta

from jose import JWTError, jwt
from passlib.context import CryptContext

import config

_pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")

TOKEN_EXPIRE_DAYS = 7


def hash_password(password: str) -> str:
    return _pwd.hash(password)


def verify_password(plain: str, hashed: str) -> bool:
    return _pwd.verify(plain, hashed)


def create_token(user_id: int, email: str, role: str) -> str:
    expire = datetime.utcnow() + timedelta(days=TOKEN_EXPIRE_DAYS)
    payload = {"sub": str(user_id), "email": email, "role": role, "exp": expire}
    return jwt.encode(payload, config.JWT_SECRET, algorithm="HS256")


def decode_token(token: str) -> dict | None:
    try:
        return jwt.decode(token, config.JWT_SECRET, algorithms=["HS256"])
    except JWTError:
        return None
