from __future__ import annotations

import datetime as dt
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class TraceStepResponse(BaseModel):
    id: str
    run_id: str
    ts: dt.datetime
    type: str
    label: Optional[str]
    input_json: Optional[Dict[str, Any]]
    output_json: Optional[Dict[str, Any]]
    latency_ms: Optional[int]


class TraceRunResponse(BaseModel):
    id: str
    session_id: str
    started_at: dt.datetime
    finished_at: Optional[dt.datetime]
    status: str
    model_id: Optional[str]
    total_tokens: Optional[int]
    prompt_tokens: Optional[int]
    completion_tokens: Optional[int]
    latency_ms: Optional[int]
    steps: List[TraceStepResponse] = Field(default_factory=list)
