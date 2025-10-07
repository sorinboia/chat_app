from pathlib import Path

from fastapi.testclient import TestClient

from backend.app.main import app

DB_PATH = Path(__file__).resolve().parents[1] / "app.db"


def setup_module(module):
    if DB_PATH.exists():
        DB_PATH.unlink()


def test_basic_flow():
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


if __name__ == "__main__":
    setup_module(None)
    test_basic_flow()
    print("Smoke test passed")
