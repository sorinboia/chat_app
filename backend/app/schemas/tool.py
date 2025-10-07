from __future__ import annotations

from typing import Any, Dict, Optional

from pydantic import BaseModel, Field


class ToolCallRequest(BaseModel):
    server_name: str
    tool_name: str
    arguments: Dict[str, Any] = Field(default_factory=dict)


class ToolCallResponse(BaseModel):
    run_id: str
    output: Dict[str, Any]
    message: Optional[str] = None
