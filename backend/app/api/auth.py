from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select

from ..core.database import AsyncSession

from ..core.dependencies import get_app_config, get_current_user, get_db
from ..models import User
from ..schemas import AuthUser, LoginRequest, TokenResponse
from ..utils.security import create_access_token, verify_password

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login", response_model=TokenResponse)
async def login(payload: LoginRequest, session: AsyncSession = Depends(get_db), app_config=Depends(get_app_config)):
    stmt = select(User).where(User.email == payload.email)
    result = await session.execute(stmt)
    user = result.scalar_one_or_none()
    if not user or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")

    token = create_access_token(subject=user.id, secret=app_config.secrets.jwt_secret)
    return TokenResponse(access_token=token)


@router.get("/me", response_model=AuthUser)
async def me(current_user: User = Depends(get_current_user)):
    return AuthUser(
        id=current_user.id,
        email=current_user.email,
        full_name=current_user.full_name,
        title=current_user.title,
        team=current_user.team,
        avatar_url=current_user.avatar_url,
    )
