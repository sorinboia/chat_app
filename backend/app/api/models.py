from __future__ import annotations

from fastapi import APIRouter, Depends

from ..core.dependencies import get_app_config
from ..services.ollama import OllamaService

router = APIRouter(prefix="/models", tags=["models"])


@router.get("", name="list_models")
async def list_models(app_config=Depends(get_app_config)):
    models_config = app_config.models
    service = OllamaService(
        base_url=models_config.ollama.base_url,
        discover=models_config.ollama.discover_models,
        fallback_models=[models_config.default_model],
    )
    models = await service.list_models()
    return {"models": models}
