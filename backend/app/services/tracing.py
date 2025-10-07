from __future__ import annotations

import datetime as dt
from typing import Any, Dict, Optional

from ..core.database import AsyncSession
from ..models import TraceRun, TraceStep


class TraceService:
    async def start_run(
        self,
        session: AsyncSession,
        *,
        session_id: str,
        model_id: Optional[str],
    ) -> TraceRun:
        run = TraceRun(
            session_id=session_id,
            started_at=dt.datetime.utcnow(),
            status="running",
            model_id=model_id,
        )
        session.add(run)
        await session.flush()
        return run

    async def add_step(
        self,
        session: AsyncSession,
        *,
        run_id: str,
        step_type: str,
        label: Optional[str] = None,
        input_payload: Optional[Dict[str, Any]] = None,
        output_payload: Optional[Dict[str, Any]] = None,
        latency_ms: Optional[int] = None,
    ) -> TraceStep:
        step = TraceStep(
            run_id=run_id,
            type=step_type,
            label=label,
            input_json=input_payload,
            output_json=output_payload,
            latency_ms=latency_ms,
        )
        session.add(step)
        await session.flush()
        return step

    async def finish_run(
        self,
        session: AsyncSession,
        *,
        run_id: str,
        status: str = "completed",
        total_tokens: Optional[int] = None,
        prompt_tokens: Optional[int] = None,
        completion_tokens: Optional[int] = None,
        latency_ms: Optional[int] = None,
    ) -> None:
        run = await session.get(TraceRun, run_id)
        if not run:
            return
        run.status = status
        run.finished_at = dt.datetime.utcnow()
        run.total_tokens = total_tokens
        run.prompt_tokens = prompt_tokens
        run.completion_tokens = completion_tokens
        run.latency_ms = latency_ms
        await session.flush()
