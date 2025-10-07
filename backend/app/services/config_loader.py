from __future__ import annotations

import datetime as dt
from pathlib import Path
from typing import Optional

from pydantic import BaseModel
from sqlalchemy import select

from ..core.database import AsyncSession

from ..core.config import AppConfig, ConfigLoaderError, ConfigSet, load_config_set
from ..models import ConfigCache


class ConfigService:
    def __init__(self, config_dir: Path) -> None:
        self._config_dir = config_dir
        self._config: Optional[ConfigSet] = None

    @property
    def config_dir(self) -> Path:
        return self._config_dir

    def load(self) -> ConfigSet:
        self._config = load_config_set(self._config_dir)
        return self._config

    def get(self) -> ConfigSet:
        if self._config is None:
            self.load()
        assert self._config is not None
        return self._config

    def get_app_config(self) -> AppConfig:
        return self.get().app_config

    async def cache_to_db(self, session: AsyncSession, version: str = "v1") -> None:
        config_set = self.get()
        payload = config_set.app_config.safe_payload
        cache = await session.scalar(select(ConfigCache).where(ConfigCache.key == "app_config"))
        timestamp = dt.datetime.utcnow()
        if cache:
            cache.json = payload
            cache.loaded_at = timestamp
            cache.version = version
        else:
            cache = ConfigCache(
                key="app_config",
                json=payload,
                loaded_at=timestamp,
                version=version,
            )
            session.add(cache)
        await session.commit()


class ConfigState(BaseModel):
    app_config: AppConfig
    config_dir: Path


def create_config_service() -> ConfigService:
    config_dir = Path(__file__).resolve().parents[3] / "config"
    return ConfigService(config_dir=config_dir)
