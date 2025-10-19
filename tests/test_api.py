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
from backend.app.core.dependencies import get_uploads_directory
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
                "thinking": "Considering how to summarize configuration details.",
                "tool_calls": [],
            },
            "raw": {},
        },
        {
            "message": {
                "role": "assistant",
                "content": "Stubbed Title",
                "thinking": "Generate a concise title.",
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
        message_payload = message_response.json()
        assert message_payload["role"] == "assistant"
        assert "<think>" in message_payload["content"]
        assert "Considering how to summarize configuration details." in message_payload["content"]

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
                "thinking": "Evaluate prior context before answering.",
                "tool_calls": [],
            },
            "raw": {},
        },
        {
            "message": {
                "role": "assistant",
                "content": "Configuration Overview",
                "thinking": "Title must be short and descriptive.",
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


def test_rag_endpoints_provide_global_context(monkeypatch):
    responses = [
        {
            "message": {
                "role": "assistant",
                "content": "Here is what I found about routers.",
                "tool_calls": [],
            },
            "raw": {},
        },
        {
            "message": {
                "role": "assistant",
                "content": "Routers Overview",
                "tool_calls": [],
            },
            "raw": {},
        },
        {
            "message": {
                "role": "assistant",
                "content": "Routers notes continued.",
                "tool_calls": [],
            },
            "raw": {},
        },
        {
            "message": {
                "role": "assistant",
                "content": "Network Chat",
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

        upload_response = client.post(
            "/rag/uploads",
            files=[('files', ("routers.txt", b"Routers route packets across networks.", "text/plain"))],
            headers=headers,
        )
        assert upload_response.status_code == 201
        uploads_payload = upload_response.json()
        assert uploads_payload and uploads_payload[0]["filename"] == "routers.txt"

        query_response = client.post(
            "/rag/query",
            json={"query": "packets"},
            headers=headers,
        )
        assert query_response.status_code == 200
        query_payload = query_response.json()
        assert query_payload["chunks"], "Expected retrieval chunks for uploaded document"
        assert any("packets" in chunk["text"].lower() for chunk in query_payload["chunks"])

        session_one = client.post("/sessions", json={}, headers=headers)
        assert session_one.status_code == 201
        session_one_id = session_one.json()["id"]
        first_message = client.post(
            f"/sessions/{session_one_id}/messages",
            data={"content": "Explain how routers forward packets."},
            headers=headers,
        )
        assert first_message.status_code == 200

        session_two = client.post("/sessions", json={}, headers=headers)
        assert session_two.status_code == 201
        session_two_id = session_two.json()["id"]
        second_message = client.post(
            f"/sessions/{session_two_id}/messages",
            data={"content": "What is a router?"},
            headers=headers,
        )
        assert second_message.status_code == 200

        runs_one = client.get(f"/traces/sessions/{session_one_id}", headers=headers)
        assert runs_one.status_code == 200
        run_one_id = runs_one.json()[0]["id"]
        run_one_detail = client.get(f"/traces/{run_one_id}", headers=headers)
        assert run_one_detail.status_code == 200
        assert any(step["type"] == "rag" for step in run_one_detail.json()["steps"])

        runs_two = client.get(f"/traces/sessions/{session_two_id}", headers=headers)
        assert runs_two.status_code == 200
        run_two_id = runs_two.json()[0]["id"]
        run_two_detail = client.get(f"/traces/{run_two_id}", headers=headers)
        assert run_two_detail.status_code == 200
        assert any(step["type"] == "rag" for step in run_two_detail.json()["steps"])

    assert len(stub_service.calls) == 4


def test_rag_upload_delete_removes_documents_and_files():
    uploads_dir = get_uploads_directory()
    before_files = {path.name for path in uploads_dir.iterdir() if path.is_file()}

    with TestClient(app) as client:
        login_payload = {"email": "amber.lee@example.com", "password": "DemoPass123!"}
        login_response = client.post("/auth/login", json=login_payload)
        assert login_response.status_code == 200
        token = login_response.json()["access_token"]
        headers = {"Authorization": f"Bearer {token}"}

        upload_response = client.post(
            "/rag/uploads",
            files=[('files', ("notes.txt", b"This is a test chunk for deletion.", "text/plain"))],
            headers=headers,
        )
        assert upload_response.status_code == 201
        upload_payload = upload_response.json()
        assert upload_payload
        upload_id = upload_payload[0]["id"]

        query_response = client.post(
            "/rag/query",
            json={"query": "test chunk"},
            headers=headers,
        )
        assert query_response.status_code == 200
        assert query_response.json()["chunks"], "Expected retrieval results before deletion"

        delete_response = client.delete(f"/rag/uploads/{upload_id}", headers=headers)
        assert delete_response.status_code == 204

        list_response = client.get("/rag/uploads", headers=headers)
        assert list_response.status_code == 200
        assert list_response.json() == []

        post_delete_query = client.post(
            "/rag/query",
            json={"query": "test chunk"},
            headers=headers,
        )
        assert post_delete_query.status_code == 200
        assert post_delete_query.json()["chunks"] == []

    after_files = {path.name for path in uploads_dir.iterdir() if path.is_file()}
    assert after_files == before_files

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
