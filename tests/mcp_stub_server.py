"""Minimal MCP stdio server used for integration tests."""

from __future__ import annotations

import json
import sys
from typing import Any, Dict

TOOLS = [
    {
        "name": "say_hello",
        "description": "Return a friendly greeting.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "Name to greet",
                }
            },
        },
    }
]


def write(msg: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def main() -> None:
    for line in sys.stdin:
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue

        method = payload.get("method")
        msg_id = payload.get("id")

        if method == "initialize":
            write(
                {
                    "jsonrpc": "2.0",
                    "id": msg_id,
                    "result": {
                        "protocolVersion": "2024-11-05",
                        "capabilities": {"tools": {"listChanged": False}},
                        "serverInfo": {"name": "stub", "version": "0.1"},
                    },
                }
            )
        elif method == "notifications/initialized":
            continue
        elif method == "tools/list":
            write(
                {
                    "jsonrpc": "2.0",
                    "id": msg_id,
                    "result": {"tools": TOOLS},
                }
            )
        elif method == "tools/call":
            params = payload.get("params") or {}
            name = params.get("name")
            arguments = params.get("arguments") or {}
            greeting_target = arguments.get("name", "world")
            output = f"Hello, {greeting_target}!"
            if name != "say_hello":
                output = f"Unknown tool '{name}'"
            write(
                {
                    "jsonrpc": "2.0",
                    "id": msg_id,
                    "result": {
                        "content": [{"type": "text", "text": output}],
                        "isError": name != "say_hello",
                    },
                }
            )
        elif method == "shutdown":
            write({"jsonrpc": "2.0", "id": msg_id, "result": None})
            break
        else:
            write(
                {
                    "jsonrpc": "2.0",
                    "id": msg_id,
                    "error": {"code": -32601, "message": "Method not found"},
                }
            )

 
if __name__ == "__main__":
    main()
