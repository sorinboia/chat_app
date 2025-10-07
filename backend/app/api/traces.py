from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from ..core.database import AsyncSession

from ..core.dependencies import get_current_user, get_db
from ..models import ChatSession, TraceRun, TraceStep, User
from ..schemas import TraceRunResponse, TraceStepResponse

router = APIRouter(prefix="/traces", tags=["traces"])


async def _ensure_session(db: AsyncSession, user: User, session_id: str) -> ChatSession:
    session = await db.get(ChatSession, session_id)
    if not session or session.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")
    return session


@router.get("/sessions/{session_id}", response_model=list[TraceRunResponse])
async def list_runs_for_session(
    session_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    session = await _ensure_session(db, current_user, session_id)
    stmt = (
        select(TraceRun)
        .where(TraceRun.session_id == session.id)
        .order_by(TraceRun.started_at.desc())
    )
    result = await db.execute(stmt)
    runs = result.scalars().all()
    return [
        TraceRunResponse(
            id=run.id,
            session_id=run.session_id,
            started_at=run.started_at,
            finished_at=run.finished_at,
            status=run.status,
            model_id=run.model_id,
            total_tokens=run.total_tokens,
            prompt_tokens=run.prompt_tokens,
            completion_tokens=run.completion_tokens,
            latency_ms=run.latency_ms,
        )
        for run in runs
    ]


@router.get("/{run_id}", response_model=TraceRunResponse)
async def get_run(
    run_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    stmt = (
        select(TraceRun)
        .options(selectinload(TraceRun.steps))
        .where(TraceRun.id == run_id)
    )
    result = await db.execute(stmt)
    run = result.scalar_one_or_none()
    if not run:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Run not found")
    session = await db.get(ChatSession, run.session_id)
    if not session or session.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Run not found")
    return TraceRunResponse(
        id=run.id,
        session_id=run.session_id,
        started_at=run.started_at,
        finished_at=run.finished_at,
        status=run.status,
        model_id=run.model_id,
        total_tokens=run.total_tokens,
        prompt_tokens=run.prompt_tokens,
        completion_tokens=run.completion_tokens,
        latency_ms=run.latency_ms,
        steps=[
            TraceStepResponse(
                id=step.id,
                run_id=step.run_id,
                ts=step.ts,
                type=step.type,
                label=step.label,
                input_json=step.input_json,
                output_json=step.output_json,
                latency_ms=step.latency_ms,
            )
            for step in sorted(run.steps, key=lambda step: step.ts)
        ],
    )
