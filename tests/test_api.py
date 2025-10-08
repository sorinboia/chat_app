from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Dict, List
import sys

TEST_DB_PATH = Path(__file__).resolve().parents[1] / "test_app.db"
os.environ.setdefault("APP_DB_PATH", str(TEST_DB_PATH))
ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from fastapi.testclient import TestClient

import backend.app.api.sessions as session_api
from backend.app.main import app


def setup_module(module):
    db_path = Path(os.environ["APP_DB_PATH"])
    if db_path.exists():
        db_path.unlink()


class StubOllamaService:
    def __init__(self, responses: List[Dict[str, Any]]):
        self._responses = responses
        self.calls: List[Dict[str, Any]] = []

    async def chat(
        self,
        *,
        model: str,
        messages: List[Dict[str, Any]],
        options: Dict[str, Any] | None = None,
        tools: List[Dict[str, Any]] | None = None,
    ) -> Dict[str, Any]:
        call_index = len(self.calls)
        self.calls.append({"model": model, "messages": messages, "tools": tools})
        if call_index >= len(self._responses):
            raise AssertionError("Unexpected Ollama chat invocation during test")
        return self._responses[call_index]

    async def list_models(self) -> List[Dict[str, Any]]:
        return []


def test_basic_flow(monkeypatch):
    responses = [
        {
            "message": {
                "role": "assistant",
                "content": "Stubbed assistant reply.",
                "tool_calls": [],
            },
            "raw": {},
        },
        {
            "message": {
                "role": "assistant",
                "content": "Stubbed Title",
                "tool_calls": [],
            },
            "raw": {},
        },
    ]
    stub_service = StubOllamaService(responses)
    monkeypatch.setattr(session_api, "get_ollama_service", lambda: stub_service)

    with TestClient(app) as client:
        print("TestClient started")
        login_payload = {"email": "amber.lee@example.com", "password": "DemoPass123!"}
        login_response = client.post("/auth/login", json=login_payload)
        print("Login response", login_response.status_code)
        assert login_response.status_code == 200
        token = login_response.json()["access_token"]
        headers = {"Authorization": f"Bearer {token}"}

        config_response = client.get("/config")
        print("Config response", config_response.status_code)
        assert config_response.status_code == 200
        assert "models" in config_response.json()

        session_response = client.post("/sessions", json={}, headers=headers)
        print("Session response", session_response.status_code)
        assert session_response.status_code == 201
        session_id = session_response.json()["id"]

        message_response = client.post(
            f"/sessions/{session_id}/messages",
            data={"content": "Hello, can you summarize the configuration?"},
            headers=headers,
        )
        print("Message response", message_response.status_code)
        assert message_response.status_code == 200
        assert message_response.json()["role"] == "assistant"

        runs_response = client.get(f"/traces/sessions/{session_id}", headers=headers)
        print("Runs response", runs_response.status_code)
        assert runs_response.status_code == 200
        runs = runs_response.json()
        assert runs, "Expected at least one run recorded"

        run_id = runs[0]["id"]
        run_detail = client.get(f"/traces/{run_id}", headers=headers)
        print("Run detail response", run_detail.status_code)
        assert run_detail.status_code == 200
        detail_payload = run_detail.json()
        assert detail_payload["steps"], "Run details should include steps"


def test_first_message_generates_session_title(monkeypatch):
    responses = [
        {
            "message": {
                "role": "assistant",
                "content": "Sure, here is a summary.",
                "tool_calls": [],
            },
            "raw": {},
        },
        {
            "message": {
                "role": "assistant",
                "content": "Configuration Overview",
                "tool_calls": [],
            },
            "raw": {},
        },
    ]
    stub_service = StubOllamaService(responses)
    monkeypatch.setattr(session_api, "get_ollama_service", lambda: stub_service)

    with TestClient(app) as client:
        login_payload = {"email": "amber.lee@example.com", "password": "DemoPass123!"}
        login_response = client.post("/auth/login", json=login_payload)
        assert login_response.status_code == 200
        token = login_response.json()["access_token"]
        headers = {"Authorization": f"Bearer {token}"}

        session_response = client.post("/sessions", json={}, headers=headers)
        assert session_response.status_code == 201
        session_id = session_response.json()["id"]

        message_content = "Hello, can you summarize the configuration?"
        message_response = client.post(
            f"/sessions/{session_id}/messages",
            data={"content": message_content},
            headers=headers,
        )
        assert message_response.status_code == 200

        session_detail = client.get(f"/sessions/{session_id}", headers=headers)
        assert session_detail.status_code == 200
        assert session_detail.json()["title"] == "Configuration Overview"

    assert len(stub_service.calls) == 2
    assert stub_service.calls[1]["tools"] is None
    assert message_content in stub_service.calls[0]["messages"][-1]["content"]


def test_session_creation_respects_persona_defaults(monkeypatch):
    stub_service = StubOllamaService([])
    monkeypatch.setattr(session_api, "get_ollama_service", lambda: stub_service)

    with TestClient(app) as client:
        login_payload = {"email": "amber.lee@example.com", "password": "DemoPass123!"}
        login_response = client.post("/auth/login", json=login_payload)
        assert login_response.status_code == 200
        token = login_response.json()["access_token"]
        headers = {"Authorization": f"Bearer {token}"}

        default_session = client.post("/sessions", json={}, headers=headers)
        assert default_session.status_code == 201
        default_body = default_session.json()
        assert default_body["persona_id"] == "mcp"
        assert default_body["model_id"] == "llama3.2:3b"
        assert default_body["rag_enabled"] is True
        assert default_body["streaming_enabled"] is False
        assert default_body["enabled_mcp_servers"] == ["playwright", "filesystem-tools"]

        debugger_session = client.post("/sessions", json={"persona_id": "debugger"}, headers=headers)
        assert debugger_session.status_code == 201
        debugger_body = debugger_session.json()
        assert debugger_body["persona_id"] == "debugger"
        assert debugger_body["rag_enabled"] is False
        assert debugger_body["streaming_enabled"] is True
        assert debugger_body["enabled_mcp_servers"] == []
        assert debugger_body["model_id"] == "llama3.2:3b"

        override_session = client.post(
            "/sessions",
            json={
                "persona_id": "debugger",
                "rag_enabled": True,
                "streaming_enabled": False,
                "enabled_mcp_servers": ["playwright"],
            },
            headers=headers,
        )
        assert override_session.status_code == 201
        override_body = override_session.json()
        assert override_body["rag_enabled"] is True
        assert override_body["streaming_enabled"] is False
        assert override_body["enabled_mcp_servers"] == ["playwright"]

        invalid_session = client.post("/sessions", json={"persona_id": "unknown"}, headers=headers)
        assert invalid_session.status_code == 400


if __name__ == "__main__":
    setup_module(None)
    test_basic_flow()
    print("Smoke test passed")
