from __future__ import annotations

from typing import Any, Dict, List, Optional

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

    async def chat(
        self,
        *,
        model: str,
        messages: List[Dict[str, str]],
        options: Optional[Dict[str, Any]] = None,
    ) -> str:
        payload: Dict[str, Any] = {
            "model": model,
            "messages": messages,
            "stream": False,
        }
        if options:
            payload["options"] = options

        try:
            async with httpx.AsyncClient(timeout=30) as client:
                response = await client.post(f"{self.base_url}/api/chat", json=payload)
                response.raise_for_status()
                data = response.json()
        except Exception as exc:  # pragma: no cover - transport-level failure reporting
            raise RuntimeError(f"Failed to invoke Ollama chat API: {exc}") from exc

        message = data.get("message")
        if isinstance(message, dict):
            content = message.get("content")
            if isinstance(content, str):
                return content.strip()

        choices = data.get("choices")
        if isinstance(choices, list) and choices:
            choice = choices[0]
            if isinstance(choice, dict):
                # OpenAI-compatible shape
                content = choice.get("message", {}).get("content")
                if isinstance(content, str):
                    return content.strip()

        text = data.get("response")
        if isinstance(text, str):
            return text.strip()

        raise RuntimeError("Ollama chat response did not include assistant content")

    @staticmethod
    def _format_model(name: str, payload: Dict[str, Any] | None = None) -> Dict[str, Any]:
        return {
            "id": name,
            "details": payload or {},
        }
