from __future__ import annotations

import datetime as dt
from typing import List, Optional

from pydantic import BaseModel, validator


class SessionBase(BaseModel):
    title: Optional[str] = None
    model_id: Optional[str] = None
    persona_id: Optional[str] = None
    rag_enabled: Optional[bool] = None
    streaming_enabled: Optional[bool] = None
    enabled_mcp_servers: Optional[List[str]] = None


class SessionCreateRequest(SessionBase):
    pass


class SessionUpdateRequest(SessionBase):
    pass


class SessionSummary(BaseModel):
    id: str
    title: str
    model_id: Optional[str]
    persona_id: Optional[str]
    rag_enabled: bool
    streaming_enabled: bool
    enabled_mcp_servers: List[str]
    created_at: dt.datetime


class SessionDetail(SessionSummary):
    pass


class MessageBase(BaseModel):
    content: str
    attachments: Optional[List[str]] = None

    @validator("content")
    def validate_content(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Message content cannot be empty")
        return value


class MessageCreateRequest(MessageBase):
    pass


class MessageEditRequest(BaseModel):
    content: str

    @validator("content")
    def validate_content(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Message content cannot be empty")
        return value


class MessageResponse(BaseModel):
    id: str
    role: str
    content: str
    created_at: dt.datetime
    run_id: Optional[str] = None
    edited_from_message_id: Optional[str] = None
