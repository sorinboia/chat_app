from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import AsyncIterator

from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt

from ..core.config import AppConfig
from ..models import User
from ..services.config_loader import ConfigService, create_config_service
from ..services.mcp import MCPService
from ..services.ollama import OllamaService
from ..services.rag import RAGService
from ..services.tracing import TraceService
from .database import AsyncSession, get_db_session

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login")


@lru_cache(maxsize=1)
def get_config_service() -> ConfigService:
    return create_config_service()


async def get_app_config() -> AppConfig:
    service = get_config_service()
    return service.get_app_config()


async def get_db() -> AsyncIterator[AsyncSession]:
    async with get_db_session() as session:
        yield session


@lru_cache(maxsize=1)
def get_uploads_directory() -> Path:
    base_dir = Path(__file__).resolve().parents[3]
    uploads = base_dir / "data" / "uploads"
    uploads.mkdir(parents=True, exist_ok=True)
    return uploads


def get_rag_service() -> RAGService:
    service = get_config_service()
    config = service.get().rag
    return RAGService(config=config, uploads_dir=get_uploads_directory())


def get_trace_service() -> TraceService:
    return TraceService()


@lru_cache(maxsize=1)
def get_workspace_root() -> Path:
    return Path(__file__).resolve().parents[3]


@lru_cache(maxsize=1)
def get_mcp_service() -> MCPService:
    service = get_config_service()
    config = service.get().mcp
    return MCPService(config=config, workspace_root=get_workspace_root())


@lru_cache(maxsize=1)
def get_ollama_service() -> OllamaService:
    service = get_config_service()
    models_config = service.get().models
    return OllamaService(
        base_url=models_config.ollama.base_url,
        discover=models_config.ollama.discover_models,
        fallback_models=[models_config.default_model],
    )


async def get_current_user(
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_db),
    app_config: AppConfig = Depends(get_app_config),
) -> User:
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, app_config.secrets.jwt_secret, algorithms=["HS256"])
        subject: str | None = payload.get("sub")
        if subject is None:
            raise credentials_exception
    except JWTError as exc:
        raise credentials_exception from exc
    user = await session.get(User, subject)
    if user is None:
        raise credentials_exception
    return user
