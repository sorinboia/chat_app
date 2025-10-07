from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Dict

from ..core.config import MCPConfig


class MCPService:
    def __init__(self, config: MCPConfig, workspace_root: Path) -> None:
        self.config = config
        self.workspace_root = workspace_root

    def execute(self, server_name: str, tool_name: str, arguments: Dict[str, Any] | None = None) -> Dict[str, Any]:
        arguments = arguments or {}
        server = next((server for server in self.config.servers if server.name == server_name), None)
        if not server:
            raise ValueError(f"Unknown MCP server '{server_name}'")
        if server.transport == "stdio" and server_name == "filesystem-tools":
            return self._handle_filesystem_tool(tool_name, arguments)
        # For other transports, this demo implementation echoes the request
        return {
            "tool_name": tool_name,
            "arguments": arguments,
            "message": "MCP call simulated (no external transport configured)",
        }

    def _handle_filesystem_tool(self, tool_name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
        if tool_name == "list_directory":
            rel_path = arguments.get("path", ".")
            target = (self.workspace_root / rel_path).resolve()
            if not str(target).startswith(str(self.workspace_root.resolve())):
                raise ValueError("Path escapes workspace root")
            if not target.exists() or not target.is_dir():
                raise ValueError(f"Directory not found: {rel_path}")
            entries = sorted(os.listdir(target))[:50]
            return {"entries": entries, "path": str(rel_path)}
        if tool_name == "read_file":
            rel_path = arguments.get("path")
            if not rel_path:
                raise ValueError("'path' is required")
            target = (self.workspace_root / rel_path).resolve()
            if not str(target).startswith(str(self.workspace_root.resolve())):
                raise ValueError("Path escapes workspace root")
            if not target.exists() or not target.is_file():
                raise ValueError(f"File not found: {rel_path}")
            content = target.read_text("utf-8", errors="ignore")
            return {"path": rel_path, "content": content[:5000]}
        raise ValueError(f"Unsupported tool '{tool_name}' for filesystem-tools")
