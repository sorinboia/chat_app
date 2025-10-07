from __future__ import annotations

from typing import Any, Dict, List

import httpx


class OllamaService:
    def __init__(self, base_url: str, discover: bool = True, fallback_models: List[str] | None = None) -> None:
        self.base_url = base_url.rstrip("/")
        self.discover = discover
        self.fallback_models = fallback_models or []

    async def list_models(self) -> List[Dict[str, Any]]:
        if not self.discover:
            return [self._format_model(name) for name in self.fallback_models]

        try:
            async with httpx.AsyncClient(timeout=10) as client:
                response = await client.get(f"{self.base_url}/api/tags")
                response.raise_for_status()
                data = response.json()
            models = data.get("models", [])
            if models:
                return [self._format_model(model.get("name", ""), model) for model in models]
        except Exception:
            # fall back to defaults if discovery fails
            if self.fallback_models:
                return [self._format_model(name) for name in self.fallback_models]
        return []

    @staticmethod
    def _format_model(name: str, payload: Dict[str, Any] | None = None) -> Dict[str, Any]:
        return {
            "id": name,
            "details": payload or {},
        }
