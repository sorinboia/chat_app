from __future__ import annotations

import datetime as dt
from typing import Any, Dict

from jose import jwt
from passlib.context import CryptContext

# Passlib expects the stdlib bcrypt package to expose __about__.__version__.
# Some builds of bcrypt omit it, which triggers noisy warnings when Passlib
# attempts to introspect available backends. This shim restores the attribute
# so hashing/salting proceeds quietly.
try:  # pragma: no cover - defensive patch for upstream package variance
    import bcrypt as _bcrypt

    if not hasattr(_bcrypt, "__about__"):
        class _About:
            __version__ = getattr(_bcrypt, "__version__", "unknown")

        _bcrypt.__about__ = _About()  # type: ignore[attr-defined]
except Exception:  # pragma: no cover - this is best-effort resilience
    pass

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(password: str, hashed: str) -> bool:
    return pwd_context.verify(password, hashed)


def create_access_token(*, subject: str, secret: str, expires_hours: int = 24, extra_claims: Dict[str, Any] | None = None) -> str:
    now = dt.datetime.utcnow()
    expire = now + dt.timedelta(hours=expires_hours)
    payload: Dict[str, Any] = {"sub": subject, "iat": now, "exp": expire}
    if extra_claims:
        payload.update(extra_claims)
    return jwt.encode(payload, secret, algorithm="HS256")
