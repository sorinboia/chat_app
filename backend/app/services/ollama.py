from __future__ import annotations

from typing import Any, Dict, List, Optional

import httpx


class OllamaService:
    def __init__(
        self,
        base_url: str,
        discover: bool = True,
        fallback_models: List[str] | None = None,
        timeout_seconds: float = 120,
        host_header: Optional[str] = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.discover = discover
        self.fallback_models = fallback_models or []
        self.timeout_seconds = timeout_seconds
        self._headers: Optional[Dict[str, str]] = None
        if host_header:
            self._headers = {"Host": host_header}

    async def list_models(self) -> List[Dict[str, Any]]:
        if not self.discover:
            return [self._format_model(name) for name in self.fallback_models]

        timeout = httpx.Timeout(self.timeout_seconds)
        try:
            async with httpx.AsyncClient(timeout=timeout, headers=self._headers) as client:
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
        messages: List[Dict[str, Any]],
        options: Optional[Dict[str, Any]] = None,
        tools: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "model": model,
            "messages": messages,
            "stream": False,
        }
        if options:
            payload["options"] = options
        if tools:
            payload["tools"] = tools

        timeout = httpx.Timeout(self.timeout_seconds)
        try:
            async with httpx.AsyncClient(timeout=timeout, headers=self._headers) as client:
                response = await client.post(f"{self.base_url}/api/chat", json=payload)
                response.raise_for_status()
                data = response.json()
        except Exception as exc:  # pragma: no cover - transport-level failure reporting
            raise RuntimeError(f"Failed to invoke Ollama chat API: {exc}") from exc

        message: Dict[str, Any]
        raw_message = data.get("message")
        if isinstance(raw_message, dict):
            message = raw_message
        else:
            message = {}

        if not message:
            choices = data.get("choices")
            if isinstance(choices, list) and choices:
                first_choice = choices[0]
                if isinstance(first_choice, dict):
                    choice_message = first_choice.get("message")
                    if isinstance(choice_message, dict):
                        message = choice_message

        if not message:
            text = data.get("response")
            if isinstance(text, str):
                message = {"role": "assistant", "content": text}
            else:
                message = {"role": "assistant", "content": ""}

        thinking_payload = message.get("thinking")
        normalized_thinking: Optional[str] = None
        if isinstance(thinking_payload, str):
            normalized_thinking = thinking_payload.strip()
        elif isinstance(thinking_payload, list):
            parts: List[str] = []
            for item in thinking_payload:
                if isinstance(item, str):
                    value = item.strip()
                    if value:
                        parts.append(value)
                elif isinstance(item, dict):
                    text_value = item.get("text") or item.get("content")
                    if isinstance(text_value, str):
                        value = text_value.strip()
                        if value:
                            parts.append(value)
            if parts:
                normalized_thinking = "\n\n".join(parts).strip()
        elif thinking_payload is not None:
            value = str(thinking_payload).strip()
            if value:
                normalized_thinking = value

        if normalized_thinking:
            message["thinking"] = normalized_thinking
            content_value = message.get("content")
            if isinstance(content_value, str):
                content_text = content_value
            elif content_value is None:
                content_text = ""
            else:
                content_text = str(content_value)
            lower_content = content_text.lower()
            if "<think>" not in lower_content:
                prefix = f"<think>{normalized_thinking}</think>"
                if content_text:
                    message["content"] = f"{prefix}\n\n{content_text}"
                else:
                    message["content"] = prefix
            else:
                message["content"] = content_text
        else:
            message.pop("thinking", None)

        if "content" not in message or not isinstance(message.get("content"), str):
            content_value = message.get("content")
            if isinstance(content_value, str):
                message["content"] = content_value
            elif content_value is None:
                message["content"] = ""
            else:
                message["content"] = str(content_value)

        if "tool_calls" not in message or not isinstance(message.get("tool_calls"), list):
            message["tool_calls"] = []

        return {"message": message, "raw": data}

    @staticmethod
    def _format_model(name: str, payload: Dict[str, Any] | None = None) -> Dict[str, Any]:
        return {
            "id": name,
            "details": payload or {},
        }
