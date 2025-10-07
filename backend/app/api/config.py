from __future__ import annotations

from fastapi import APIRouter, Depends

from ..core.dependencies import get_app_config

router = APIRouter(prefix="/config", tags=["config"])


@router.get("", name="get_config")
async def get_config(app_config=Depends(get_app_config)):
    return app_config.safe_payload
