from __future__ import annotations

import asyncio
import json
import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

import httpx

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
        if server.transport == "streamtable_http":
            return await self._list_streamtable_http_tools(server)
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
        if server.transport == "streamtable_http":
            return await self._call_streamtable_http_tool(server, tool_name, arguments)

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

    async def _list_streamtable_http_tools(self, server: MCPServerConfig) -> List[Dict[str, Any]]:
        api_key = self._resolve_api_key(server)
        async with _StreamtableHTTPSession(
            server=server,
            api_key=api_key,
            protocol_version=_DEFAULT_PROTOCOL_VERSION,
        ) as session:
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
                "Listed %d tools for MCP streamtable_http server '%s'",
                len(tools),
                server.name,
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

    async def _call_streamtable_http_tool(
        self,
        server: MCPServerConfig,
        tool_name: str,
        arguments: Dict[str, Any],
    ) -> Dict[str, Any]:
        api_key = self._resolve_api_key(server)
        async with _StreamtableHTTPSession(
            server=server,
            api_key=api_key,
            protocol_version=_DEFAULT_PROTOCOL_VERSION,
        ) as session:
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

    def _resolve_api_key(self, server: MCPServerConfig) -> Optional[Tuple[str, str]]:
        if not server.requires_api_key:
            return None
        key_name = server.auth_key_name or server.name.upper() + "_API_KEY"
        key_value = self.api_keys.get(key_name)
        if not key_value:
            raise ValueError(
                f"Missing API key for MCP server '{server.name}' (expected '{key_name}')"
            )
        return key_name, key_value

    def _build_env(self, server: MCPServerConfig) -> Dict[str, str]:
        env = os.environ.copy()
        injected: List[str] = []
        resolved = self._resolve_api_key(server)
        if resolved:
            key_name, key_value = resolved
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


@dataclass
class _StreamtableHTTPSession:
    server: MCPServerConfig
    api_key: Optional[Tuple[str, str]]
    protocol_version: str
    request_timeout: float = 60.0

    def __post_init__(self) -> None:
        self._client: httpx.AsyncClient | None = None
        self._session_id: Optional[str] = None
        self._next_id = 0
        self._endpoint = self.server.base_url
        self._default_headers: Dict[str, str] = {}

    async def __aenter__(self) -> "_StreamtableHTTPSession":
        if not self._endpoint:
            raise ValueError(
                f"MCP server '{self.server.name}' is missing a base_url for streamtable_http transport"
            )
        timeout = httpx.Timeout(self.request_timeout, connect=10.0)
        self._client = httpx.AsyncClient(timeout=timeout)
        self._default_headers = self._build_default_headers()
        await self._initialize()
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:  # type: ignore[override]
        try:
            await self._shutdown()
        finally:
            if self._client:
                await self._client.aclose()
                self._client = None

    async def request(self, method: str, params: Dict[str, Any] | None = None) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "jsonrpc": _JSONRPC_VERSION,
            "id": self._next_request_id(),
            "method": method,
        }
        if params is not None:
            payload["params"] = params
        response = await self._send_message(payload, expect_response=True)
        return response or {}

    async def notify(self, method: str, params: Dict[str, Any] | None = None) -> None:
        payload: Dict[str, Any] = {
            "jsonrpc": _JSONRPC_VERSION,
            "method": method,
        }
        if params is not None:
            payload["params"] = params
        await self._send_message(payload, expect_response=False)

    async def _initialize(self) -> None:
        response = await self._send_message(
            {
                "jsonrpc": _JSONRPC_VERSION,
                "id": self._next_request_id(),
                "method": "initialize",
                "params": {
                    "protocolVersion": self.protocol_version,
                    "capabilities": {"tools": {"listChanged": True}},
                    "clientInfo": {"name": "chat-app-backend", "version": "1.0"},
                },
            },
            expect_response=True,
            include_session=False,
        )
        if not isinstance(response, dict):
            raise RuntimeError(
                f"Invalid initialize response from MCP server '{self.server.name}': {response!r}"
            )
        if "error" in response:
            raise RuntimeError(
                f"Failed to initialize MCP server '{self.server.name}': {response['error']}"
            )
        result = response.get("result") if isinstance(response, dict) else None
        negotiated = result.get("protocolVersion") if isinstance(result, dict) else None
        if isinstance(negotiated, str):
            self.protocol_version = negotiated
            self._default_headers["MCP-Protocol-Version"] = negotiated
        await self.notify("notifications/initialized")

    async def _shutdown(self) -> None:
        if not self._client:
            return
        try:
            await self._send_message(
                {
                    "jsonrpc": _JSONRPC_VERSION,
                    "id": self._next_request_id(),
                    "method": "shutdown",
                },
                expect_response=True,
            )
        except Exception:
            logger.debug("Failed to send shutdown to MCP server '%s'", self.server.name, exc_info=True)
        if self._session_id:
            try:
                headers = self._compose_headers(include_session=True, content_type=False)
                await self._client.delete(self._endpoint, headers=headers)
            except Exception:
                logger.debug(
                    "Failed to send DELETE shutdown signal to MCP server '%s'",
                    self.server.name,
                    exc_info=True,
                )

    async def _send_message(
        self,
        payload: Dict[str, Any],
        *,
        expect_response: bool,
        include_session: bool = True,
    ) -> Optional[Dict[str, Any]]:
        if not self._client:
            raise RuntimeError("MCP streamtable HTTP session is not initialized")
        headers = self._compose_headers(include_session=include_session)
        if expect_response:
            async with self._client.stream(
                "POST",
                self._endpoint,
                headers=headers,
                json=payload,
            ) as response:
                await self._ensure_success(response)
                self._capture_session_id(response)
                parsed = await self._parse_response(response, payload.get("id"))
                return parsed
        response = await self._client.post(
            self._endpoint,
            headers=headers,
            json=payload,
        )
        self._capture_session_id(response)
        if response.status_code not in (202, 204):
            detail = response.text.strip()
            raise RuntimeError(
                f"MCP HTTP notification failed for server '{self.server.name}' "
                f"(status={response.status_code}, detail={detail or 'no body'})"
            )
        return None

    async def _ensure_success(self, response: httpx.Response) -> None:
        if response.status_code < 400:
            return
        body_bytes = await response.aread()
        encoding = response.encoding or "utf-8"
        body_text = body_bytes.decode(encoding, errors="ignore") if body_bytes else ""
        raise RuntimeError(
            f"MCP HTTP request failed for server '{self.server.name}' "
            f"(status={response.status_code}, detail={body_text or 'no body'})"
        )

    async def _parse_response(
        self, response: httpx.Response, target_id: Optional[int]
    ) -> Dict[str, Any]:
        content_type = response.headers.get("content-type", "")
        if "text/event-stream" in content_type:
            return await self._consume_sse(response, target_id)
        raw = await response.aread()
        if not raw:
            return {}
        encoding = response.encoding or "utf-8"
        text = raw.decode(encoding, errors="ignore")
        try:
            return json.loads(text)
        except json.JSONDecodeError as exc:
            raise RuntimeError(
                f"Invalid JSON response from MCP server '{self.server.name}': {text}"
            ) from exc

    async def _consume_sse(
        self,
        response: httpx.Response,
        target_id: Optional[int],
    ) -> Dict[str, Any]:
        data_lines: List[str] = []
        async for line in response.aiter_lines():
            if line is None:
                continue
            stripped = line.strip("\n")
            if not stripped:
                if not data_lines:
                    continue
                payload = "\n".join(data_lines)
                data_lines.clear()
                try:
                    message = json.loads(payload)
                except json.JSONDecodeError:
                    logger.debug(
                        "Ignoring non-JSON SSE message from MCP server '%s': %s",
                        self.server.name,
                        payload,
                    )
                    continue
                if target_id is None or message.get("id") == target_id or "result" in message or "error" in message:
                    if target_id is not None and message.get("id") != target_id and "result" not in message and "error" not in message:
                        logger.debug(
                            "Skipping SSE message without matching id for server '%s': %s",
                            self.server.name,
                            message,
                        )
                        continue
                    return message
                logger.debug(
                    "Ignoring out-of-band SSE message from MCP server '%s': %s",
                    self.server.name,
                    message,
                )
                continue
            if stripped.startswith(":"):
                continue
            if stripped.startswith("data:"):
                data_lines.append(stripped[5:].lstrip())
                continue
            # Ignore other SSE fields (id, event, retry) for now.
        if data_lines:
            payload = "\n".join(data_lines)
            try:
                message = json.loads(payload)
                return message
            except json.JSONDecodeError:
                pass
        raise RuntimeError(
            f"Did not receive response for request {target_id!r} from MCP server '{self.server.name}'"
        )

    def _compose_headers(self, *, include_session: bool, content_type: bool = True) -> Dict[str, str]:
        headers = dict(self._default_headers)
        if content_type:
            headers["Content-Type"] = "application/json"
        if include_session and self._session_id:
            headers["Mcp-Session-Id"] = self._session_id
        return headers

    def _capture_session_id(self, response: httpx.Response) -> None:
        if self._session_id:
            return
        session_id = response.headers.get("mcp-session-id")
        if session_id:
            self._session_id = session_id

    def _build_default_headers(self) -> Dict[str, str]:
        headers: Dict[str, str] = {
            "Accept": "application/json, text/event-stream",
            "MCP-Protocol-Version": self.protocol_version,
        }
        if self.api_key:
            key_name, key_value = self.api_key
            key_value_str = str(key_value)
            if key_value_str.lower().startswith("bearer "):
                headers["Authorization"] = key_value_str
            else:
                headers["Authorization"] = f"Bearer {key_value_str}"
            headers["X-API-Key"] = key_value_str
            headers[key_name] = key_value_str
            normalized = "-".join(part.capitalize() for part in key_name.split("_"))
            headers[normalized] = key_value_str
        return headers

    def _next_request_id(self) -> int:
        self._next_id += 1
        return self._next_id
