from __future__ import annotations

import asyncio
import json
import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from ..core.config import MCPConfig, MCPServerConfig

_JSONRPC_VERSION = "2.0"
_DEFAULT_PROTOCOL_VERSION = "2024-11-05"
_TOOL_NAME_SEPARATOR = "__"


logger = logging.getLogger(__name__)


class MCPService:
    """Interface for interacting with configured MCP servers."""

    def __init__(
        self,
        *,
        config: MCPConfig,
        workspace_root: Path,
        api_keys: Dict[str, str] | None = None,
    ) -> None:
        self.config = config
        self.workspace_root = workspace_root
        self.api_keys = api_keys or {}

    def _get_server(self, server_name: str) -> MCPServerConfig:
        for server in self.config.servers:
            if server.name == server_name:
                return server
        raise ValueError(f"Unknown MCP server '{server_name}'")

    async def list_tools(self, server_name: str) -> List[Dict[str, Any]]:
        server = self._get_server(server_name)
        if server.transport == "stdio":
            if server_name == "filesystem-tools":
                return self._filesystem_tool_catalog()
            return await self._list_stdio_tools(server)
        raise ValueError(f"Transport '{server.transport}' not implemented for listing tools")

    async def build_tool_definitions(
        self, server_names: Iterable[str]
    ) -> Tuple[List[Dict[str, Any]], Dict[str, Dict[str, str]]]:
        """Return Ollama tool definitions and lookup metadata for enabled servers."""

        definitions: List[Dict[str, Any]] = []
        lookup: Dict[str, Dict[str, str]] = {}

        for server_name in server_names:
            logger.debug("Building tool definitions for server '%s'", server_name)
            try:
                tools = await self.list_tools(server_name)
            except Exception:
                # Surface an empty list but continue building other tool definitions.
                logger.exception("Failed to list tools for MCP server '%s'", server_name)
                continue

            for tool in tools:
                tool_name = tool.get("name")
                if not tool_name:
                    continue
                function_name = self._encode_tool_name(server_name, tool_name)
                description = (
                    tool.get("description")
                    or tool.get("title")
                    or f"Tool '{tool_name}' exposed by {server_name}"
                )
                parameters = tool.get("inputSchema") or {"type": "object", "properties": {}}
                if not isinstance(parameters, dict):
                    parameters = {"type": "object", "properties": {}}

                definitions.append(
                    {
                        "type": "function",
                        "function": {
                            "name": function_name,
                            "description": f"{description} (via {server_name})",
                            "parameters": parameters,
                        },
                    }
                )
                lookup[function_name] = {
                    "server_name": server_name,
                    "tool_name": tool_name,
                }

        return definitions, lookup

    async def execute(
        self,
        server_name: str,
        tool_name: str,
        arguments: Dict[str, Any] | None = None,
    ) -> Dict[str, Any]:
        arguments = arguments or {}
        server = self._get_server(server_name)

        logger.info(
            "Executing MCP tool %s.%s with arguments=%s", server_name, tool_name, arguments
        )

        if server.transport == "stdio":
            if server_name == "filesystem-tools":
                return self._handle_filesystem_tool(tool_name, arguments)
            return await self._call_stdio_tool(server, tool_name, arguments)

        raise ValueError(f"Transport '{server.transport}' not implemented for tool execution")

    async def _list_stdio_tools(self, server: MCPServerConfig) -> List[Dict[str, Any]]:
        async with _StdioSession(server, self.workspace_root, self._build_env(server)) as session:
            tools: List[Dict[str, Any]] = []
            cursor: Optional[str] = None
            while True:
                params = {"cursor": cursor} if cursor else None
                response = await session.request("tools/list", params=params)
                result = response.get("result", {}) if isinstance(response, dict) else {}
                tools.extend(result.get("tools", []) or [])
                cursor = result.get("nextCursor")
                if not cursor:
                    break
            logger.debug(
                "Listed %d tools for MCP stdio server '%s'", len(tools), server.name
            )
            return tools

    async def _call_stdio_tool(
        self,
        server: MCPServerConfig,
        tool_name: str,
        arguments: Dict[str, Any],
    ) -> Dict[str, Any]:
        async with _StdioSession(server, self.workspace_root, self._build_env(server)) as session:
            response = await session.request(
                "tools/call",
                params={"name": tool_name, "arguments": arguments},
            )
            result = response.get("result", {}) if isinstance(response, dict) else {}
            formatted = self._format_tool_result(result)
            logger.info(
                "MCP tool %s.%s returned isError=%s",
                server.name,
                tool_name,
                formatted.get("isError"),
            )
            return formatted

    def _filesystem_tool_catalog(self) -> List[Dict[str, Any]]:
        return [
            {
                "name": "list_directory",
                "description": "List entries in a workspace-relative directory (max 50 entries).",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Relative directory path; defaults to '.'",
                        }
                    },
                },
            },
            {
                "name": "read_file",
                "description": "Read up to 5000 characters from a workspace-relative file.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Relative file path",
                        }
                    },
                    "required": ["path"],
                },
            },
        ]

    def _handle_filesystem_tool(self, tool_name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
        if tool_name == "list_directory":
            rel_path = arguments.get("path", ".")
            target = (self.workspace_root / rel_path).resolve()
            self._validate_workspace_path(target)
            if not target.exists() or not target.is_dir():
                raise ValueError(f"Directory not found: {rel_path}")
            entries = sorted(os.listdir(target))[:50]
            text = "\n".join(entries) or "<empty directory>"
            return self._wrap_text_result(
                text=f"Directory listing for {rel_path}:\n{text}",
                data={"entries": entries, "path": str(rel_path)},
            )

        if tool_name == "read_file":
            rel_path = arguments.get("path")
            if not rel_path:
                raise ValueError("'path' is required")
            target = (self.workspace_root / rel_path).resolve()
            self._validate_workspace_path(target)
            if not target.exists() or not target.is_file():
                raise ValueError(f"File not found: {rel_path}")
            content = target.read_text("utf-8", errors="ignore")
            preview = content[:5000]
            return self._wrap_text_result(
                text=f"File preview for {rel_path}:\n{preview}",
                data={"path": rel_path, "content": preview},
            )

        raise ValueError(f"Unsupported tool '{tool_name}' for filesystem-tools")

    def _wrap_text_result(
        self,
        *,
        text: str,
        data: Dict[str, Any] | None = None,
        is_error: bool = False,
    ) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "content": [{"type": "text", "text": text}],
            "isError": is_error,
            "text": text,
        }
        if data is not None:
            payload["data"] = data
        payload["raw"] = payload.copy()
        return payload

    def _format_tool_result(self, result: Dict[str, Any]) -> Dict[str, Any]:
        content_items = result.get("content") or []
        text_parts: List[str] = []
        for item in content_items:
            if isinstance(item, dict) and item.get("type") == "text" and "text" in item:
                text_parts.append(str(item.get("text", "")))
            else:
                text_parts.append(json.dumps(item, ensure_ascii=False))
        text = "\n".join(part for part in text_parts if part).strip()

        payload: Dict[str, Any] = {
            "content": content_items,
            "isError": bool(result.get("isError")),
            "text": text,
            "raw": result,
        }

        if "structuredContent" in result:
            payload["structuredContent"] = result["structuredContent"]
        if "data" in result:
            payload["data"] = result["data"]

        return payload

    def _build_env(self, server: MCPServerConfig) -> Dict[str, str]:
        env = os.environ.copy()
        injected: List[str] = []
        if server.requires_api_key:
            key_name = server.auth_key_name or server.name.upper() + "_API_KEY"
            key_value = self.api_keys.get(key_name)
            if not key_value:
                raise ValueError(f"Missing API key for MCP server '{server.name}' (expected '{key_name}')")
            env[key_name] = key_value
            injected.append(key_name)
        logger.debug(
            "Prepared environment for server '%s' (injected_keys=%s)",
            server.name,
            injected,
        )
        return env

    def _validate_workspace_path(self, target: Path) -> None:
        if not str(target).startswith(str(self.workspace_root.resolve())):
            raise ValueError("Path escapes workspace root")

    def _encode_tool_name(self, server_name: str, tool_name: str) -> str:
        return f"{server_name}{_TOOL_NAME_SEPARATOR}{tool_name}"

    def decode_tool_name(self, encoded: str) -> Tuple[str, str]:
        if _TOOL_NAME_SEPARATOR not in encoded:
            raise ValueError(f"Malformed tool name '{encoded}'")
        server_name, tool_name = encoded.split(_TOOL_NAME_SEPARATOR, 1)
        return server_name, tool_name


@dataclass
class _StdioSession:
    server: MCPServerConfig
    workspace_root: Path
    env: Dict[str, str]

    def __post_init__(self) -> None:
        self._process: asyncio.subprocess.Process | None = None
        self._next_id = 0

    async def __aenter__(self) -> "_StdioSession":
        if not self.server.command:
            raise ValueError(f"MCP server '{self.server.name}' is missing a command for stdio transport")
        args = self.server.args or []
        logger.info(
            "Launching MCP stdio server '%s' with command: %s %s",
            self.server.name,
            self.server.command,
            " ".join(args),
        )
        self._process = await asyncio.create_subprocess_exec(
            self.server.command,
            *args,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=self.workspace_root,
            env=self.env,
        )
        await self._initialize()
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:  # type: ignore[override]
        await self._shutdown()
        if self._process and self._process.stdin and not self._process.stdin.is_closing():
            self._process.stdin.close()
        await self._terminate_process()

    async def request(self, method: str, params: Dict[str, Any] | None = None) -> Dict[str, Any]:
        request_id = self._next_request_id()
        payload: Dict[str, Any] = {
            "jsonrpc": _JSONRPC_VERSION,
            "id": request_id,
            "method": method,
        }
        if params is not None:
            payload["params"] = params
        await self._send(payload)
        return await self._receive(request_id)

    async def notify(self, method: str, params: Dict[str, Any] | None = None) -> None:
        payload: Dict[str, Any] = {
            "jsonrpc": _JSONRPC_VERSION,
            "method": method,
        }
        if params is not None:
            payload["params"] = params
        await self._send(payload)

    async def _initialize(self) -> None:
        response = await self.request(
            "initialize",
            params={
                "protocolVersion": _DEFAULT_PROTOCOL_VERSION,
                "capabilities": {"tools": {"listChanged": True}},
                "clientInfo": {"name": "chat-app-backend", "version": "1.0"},
            },
        )
        if "error" in response:
            raise RuntimeError(f"Failed to initialize MCP server '{self.server.name}': {response['error']}")
        await self.notify("notifications/initialized")

    async def _shutdown(self) -> None:
        try:
            await self.request("shutdown")
        except Exception:
            pass

    async def _terminate_process(self) -> None:
        if not self._process:
            return
        try:
            await asyncio.wait_for(self._process.wait(), timeout=2.0)
        except asyncio.TimeoutError:
            self._process.terminate()
            try:
                await asyncio.wait_for(self._process.wait(), timeout=2.0)
            except asyncio.TimeoutError:
                self._process.kill()

    async def _send(self, payload: Dict[str, Any]) -> None:
        if not self._process or not self._process.stdin:
            raise RuntimeError("MCP stdio session is not initialized")
        data = json.dumps(payload, separators=(',', ':')).encode("utf-8") + b"\n"
        self._process.stdin.write(data)
        await self._process.stdin.drain()

    async def _receive(self, target_id: int) -> Dict[str, Any]:
        if not self._process or not self._process.stdout:
            raise RuntimeError("MCP stdio session is not initialized")
        while True:
            line = await asyncio.wait_for(self._process.stdout.readline(), timeout=30.0)
            if not line:
                raise RuntimeError("MCP server closed the connection unexpectedly")
            try:
                message = json.loads(line.decode("utf-8"))
            except json.JSONDecodeError as exc:
                logger.error("Invalid MCP message from server '%s': %s", self.server.name, line)
                raise RuntimeError(f"Invalid MCP message: {line!r}") from exc

            if message.get("id") == target_id:
                return message
            # Ignore unrelated notifications/log messages.

    def _next_request_id(self) -> int:
        self._next_id += 1
        return self._next_id
