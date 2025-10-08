from __future__ import annotations

import asyncio
import sys
from pathlib import Path

from backend.app.core.config import MCPConfig, MCPServerConfig
from backend.app.services.mcp import MCPService

async def _run_scenario() -> None:
    workspace_root = Path(__file__).resolve().parents[1]
    stub_script = workspace_root / "tests" / "mcp_stub_server.py"

    config = MCPConfig(
        servers=[
            MCPServerConfig(
                name="stub",
                transport="stdio",
                command=sys.executable,
                args=[str(stub_script)],
            )
        ]
    )
    service = MCPService(config=config, workspace_root=workspace_root, api_keys={})

    tools = await service.list_tools("stub")
    assert tools and tools[0]["name"] == "say_hello"

    result = await service.execute("stub", "say_hello", {"name": "Tester"})
    assert result["isError"] is False
    assert "Tester" in result["text"]

    definitions, lookup = await service.build_tool_definitions(["stub"])
    assert definitions, "Expected at least one tool definition"
    function_name = definitions[0]["function"]["name"]
    server_name, tool_name = service.decode_tool_name(function_name)
    assert server_name == "stub"
    assert tool_name == "say_hello"
    assert lookup[function_name]["server_name"] == "stub"


def test_stdio_mcp_server_execution() -> None:
    asyncio.run(_run_scenario())
