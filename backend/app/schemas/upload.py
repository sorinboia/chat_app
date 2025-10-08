from __future__ import annotations

import datetime as dt
from typing import Optional

from pydantic import BaseModel


class UploadResponse(BaseModel):
    id: str
    filename: str
    mime: str
    size_bytes: int
    created_at: dt.datetime


class RAGChunkResponse(BaseModel):
    id: str
    document_id: str
    text: str
    score: float
    filename: Optional[str] = None

class RAGQueryRequest(BaseModel):
    query: str
    top_k: Optional[int] = None


class RAGQueryResponse(BaseModel):
    chunks: list[RAGChunkResponse]

