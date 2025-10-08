from __future__ import annotations

import copy
import datetime as dt
import json
import logging
import os
import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from sqlalchemy import select

from ..core.database import AsyncSession

from ..core.dependencies import (
    get_app_config,
    get_current_user,
    get_db,
    get_mcp_service,
    get_ollama_service,
    get_rag_service,
    get_trace_service,
    get_uploads_directory,
)
from ..models import ChatSession, Message, Upload, User
from ..schemas import (
    MessageResponse,
    MessageEditRequest,
    SessionCreateRequest,
    SessionDetail,
    SessionSummary,
    SessionUpdateRequest,
    ToolCallRequest,
    ToolCallResponse,
)
from ..services.mcp import MCPService
from ..services.ollama import OllamaService
from ..services.rag import RAGService, RetrievedChunk
from ..services.tracing import TraceService

router = APIRouter(prefix="/sessions", tags=["sessions"])

logger = logging.getLogger(__name__)


def _to_session_summary(session: ChatSession) -> SessionSummary:
    return SessionSummary(
        id=session.id,
        title=session.title,
        model_id=session.model_id,
        persona_id=session.persona_id,
        rag_enabled=session.rag_enabled,
        streaming_enabled=session.streaming_enabled,
        enabled_mcp_servers=session.enabled_mcp_servers or [],
        created_at=session.created_at,
    )


@router.get("", response_model=List[SessionSummary])
async def list_sessions(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    stmt = select(ChatSession).where(ChatSession.user_id == current_user.id).order_by(ChatSession.created_at.desc())
    result = await db.execute(stmt)
    sessions = result.scalars().all()
    return [_to_session_summary(session) for session in sessions]


@router.post("", response_model=SessionDetail, status_code=status.HTTP_201_CREATED)
async def create_session(
    payload: SessionCreateRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    app_config=Depends(get_app_config),
):
    default_mcp = [server.name for server in app_config.mcp.servers if server.enabled_by_default]
    session = ChatSession(
        user_id=current_user.id,
        title=payload.title or "New Chat",
        model_id=payload.model_id or app_config.models.default_model,
        persona_id=payload.persona_id or app_config.personas.default_persona_id,
        rag_enabled=payload.rag_enabled if payload.rag_enabled is not None else True,
        streaming_enabled=payload.streaming_enabled if payload.streaming_enabled is not None else False,
        enabled_mcp_servers=payload.enabled_mcp_servers if payload.enabled_mcp_servers is not None else default_mcp,
    )
    db.add(session)
    await db.commit()
    await db.refresh(session)
    return _to_session_summary(session)


async def _get_session_for_user(db: AsyncSession, user_id: str, session_id: str) -> ChatSession:
    session = await db.get(ChatSession, session_id)
    if not session or session.user_id != user_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")
    return session


@router.get("/{session_id}", response_model=SessionDetail)
async def get_session(
    session_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    session = await _get_session_for_user(db, current_user.id, session_id)
    return _to_session_summary(session)


@router.patch("/{session_id}", response_model=SessionDetail)
async def update_session(
    session_id: str,
    payload: SessionUpdateRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    session = await _get_session_for_user(db, current_user.id, session_id)
    if payload.title is not None:
        session.title = payload.title
    if payload.model_id is not None:
        session.model_id = payload.model_id
    if payload.persona_id is not None:
        session.persona_id = payload.persona_id
    if payload.rag_enabled is not None:
        session.rag_enabled = payload.rag_enabled
    if payload.streaming_enabled is not None:
        session.streaming_enabled = payload.streaming_enabled
    if payload.enabled_mcp_servers is not None:
        session.enabled_mcp_servers = payload.enabled_mcp_servers
    await db.commit()
    await db.refresh(session)
    return _to_session_summary(session)


@router.delete("/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_session(
    session_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    session = await _get_session_for_user(db, current_user.id, session_id)
    await db.delete(session)
    await db.commit()


@router.post("/{session_id}/tools/run", response_model=ToolCallResponse)
async def run_tool(
    session_id: str,
    payload: ToolCallRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    mcp_service: MCPService = Depends(get_mcp_service),
    trace_service: TraceService = Depends(get_trace_service),
):
    session = await _get_session_for_user(db, current_user.id, session_id)
    if payload.server_name not in (session.enabled_mcp_servers or []):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="MCP server not enabled for this session")
    try:
        output = await mcp_service.execute(payload.server_name, payload.tool_name, payload.arguments)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except Exception as exc:  # pragma: no cover - surface unexpected failures
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(exc)) from exc

    run = await trace_service.start_run(db, session_id=session.id, model_id=session.model_id)
    await trace_service.add_step(
        db,
        run_id=run.id,
        step_type="mcp",
        label=f"{payload.server_name}:{payload.tool_name}",
        input_payload=payload.arguments,
        output_payload=output,
    )
    await trace_service.finish_run(db, run_id=run.id, status="completed")
    await db.commit()
    return ToolCallResponse(run_id=run.id, output=output, message="Tool executed")


@router.get("/{session_id}/messages", response_model=List[MessageResponse])
async def list_messages(
    session_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    session = await _get_session_for_user(db, current_user.id, session_id)
    stmt = (
        select(Message)
        .where(Message.session_id == session.id)
        .order_by(Message.created_at.asc())
    )
    result = await db.execute(stmt)
    messages = result.scalars().all()
    return [
        MessageResponse(
            id=message.id,
            role=message.role,
            content=message.content,
            created_at=message.created_at,
            edited_from_message_id=message.edited_from_message_id,
        )
        for message in messages
    ]


async def _store_upload(
    file: UploadFile,
    *,
    uploads_dir: os.PathLike[str],
    user: User,
    chat_session: ChatSession,
    db: AsyncSession,
    rag_service: RAGService,
) -> Upload:
    filename = file.filename or "upload.bin"
    suffix = os.path.splitext(filename)[1].lower()
    allowed = {".pdf", ".md", ".txt", ".docx", ".mdx"}
    if suffix not in allowed:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Unsupported file type: {suffix}")
    data = await file.read()
    max_size = 5 * 1024 * 1024
    if len(data) > max_size:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="File exceeds 5 MB limit")
    uploads_dir = os.fspath(uploads_dir)
    os.makedirs(uploads_dir, exist_ok=True)
    stored_name = f"{uuid.uuid4()}_{filename}"
    stored_path = os.path.join(uploads_dir, stored_name)
    with open(stored_path, "wb") as f:
        f.write(data)
    upload = Upload(
        user_id=user.id,
        session_id=chat_session.id,
        filename=filename,
        path=stored_path,
        mime=file.content_type or "application/octet-stream",
        size_bytes=len(data),
    )
    db.add(upload)
    await db.commit()
    await db.refresh(upload)
    await rag_service.ingest_upload(db, upload, upload.mime)
    return upload


def _resolve_persona_prompt(persona_id: str | None, app_config) -> Optional[str]:
    personas = app_config.personas
    target_id = persona_id or personas.default_persona_id
    for persona in personas.personas:
        if persona.id == target_id:
            return persona.system_prompt
    try:
        return personas.get_default().system_prompt
    except ValueError:
        return None


def _shape_context_message(retrieved_chunks: List[RetrievedChunk]) -> Optional[str]:
    if not retrieved_chunks:
        return None
    snippets: List[str] = []
    for chunk in retrieved_chunks[:3]:
        snippet = chunk.text.strip()
        if len(snippet) > 1000:
            snippet = snippet[:1000] + "..."
        label = chunk.upload_filename or f"Chunk {chunk.chunk_id}"
        snippets.append(f"{label}:\n{snippet}")
    return "Use the following retrieved context when it is relevant:\n\n" + "\n\n".join(snippets)


async def _process_user_turn(
    *,
    chat_session: ChatSession,
    content: str,
    user: User,
    files: List[UploadFile] | None,
    db: AsyncSession,
    app_config,
    uploads_dir,
    rag_service: RAGService,
    ollama_service: OllamaService,
    mcp_service: MCPService,
    trace_service: TraceService,
    edited_from: str | None = None,
):
    user_message = Message(
        session_id=chat_session.id,
        role="user",
        content=content,
        edited_from_message_id=edited_from,
    )
    db.add(user_message)
    await db.commit()
    await db.refresh(user_message)

    run = await trace_service.start_run(db, session_id=chat_session.id, model_id=chat_session.model_id)
    await trace_service.add_step(
        db,
        run_id=run.id,
        step_type="prompt",
        label="User message",
        input_payload={"content": content},
    )

    if files:
        for file in files:
            if file is None:
                continue
            await _store_upload(
                file,
                uploads_dir=uploads_dir,
                user=user,
                chat_session=chat_session,
                db=db,
                rag_service=rag_service,
            )

    stmt_uploads = select(Upload).where(Upload.session_id == chat_session.id)
    existing_uploads = (await db.execute(stmt_uploads)).scalars().all()

    retrieved_chunks: List[RetrievedChunk] = []
    if chat_session.rag_enabled and existing_uploads:
        retrieved_chunks = await rag_service.retrieve(
            db,
            [upload.id for upload in existing_uploads],
            content,
            top_k=app_config.rag.top_k,
        )
        await trace_service.add_step(
            db,
            run_id=run.id,
            step_type="rag",
            label="Retrieved chunks",
            input_payload={"query": content},
            output_payload={
                "chunks": [
                    {
                        "chunk_id": chunk.chunk_id,
                        "score": chunk.score,
                        "text_preview": chunk.text[:200],
                        "filename": chunk.upload_filename,
                    }
                    for chunk in retrieved_chunks
                ]
            },
        )

    persona_prompt = _resolve_persona_prompt(chat_session.persona_id, app_config)
    history_stmt = (
        select(Message)
        .where(Message.session_id == chat_session.id)
        .order_by(Message.created_at.asc())
    )
    history = (await db.execute(history_stmt)).scalars().all()

    llm_messages: List[Dict[str, str]] = []
    if persona_prompt:
        llm_messages.append({"role": "system", "content": persona_prompt})

    allowed_roles = {"user", "assistant"}
    if history:
        for prior in history[:-1]:
            if prior.role in allowed_roles:
                llm_messages.append({"role": prior.role, "content": prior.content})

    context_message = _shape_context_message(retrieved_chunks)
    if context_message:
        llm_messages.append({"role": "system", "content": context_message})

    appended_latest = False
    if history:
        latest = history[-1]
        if latest.role in allowed_roles:
            llm_messages.append({"role": latest.role, "content": latest.content})
            appended_latest = True

    if not appended_latest:
        llm_messages.append({"role": "user", "content": content})

    enabled_servers = chat_session.enabled_mcp_servers or []
    if enabled_servers:
        logger.debug(
            "Session %s has MCP servers enabled: %s", chat_session.id, enabled_servers
        )
    tools_payload, tool_lookup = await mcp_service.build_tool_definitions(enabled_servers)
    logger.debug(
        "Prepared %d MCP tool definitions for session %s",
        len(tools_payload),
        chat_session.id,
    )

    assistant_text = ""
    tool_iterations = 0
    max_tool_iterations = 4

    while True:
        request_snapshot = copy.deepcopy(llm_messages)
        llm_request_payload: Dict[str, object] = {
            "model": chat_session.model_id,
            "messages": request_snapshot,
        }
        if tools_payload:
            llm_request_payload["tools"] = tools_payload

        try:
            response = await ollama_service.chat(
                model=chat_session.model_id,
                messages=request_snapshot,
                tools=tools_payload if tools_payload else None,
            )
        except RuntimeError as exc:
            assistant_text = (
                "I couldn't reach the model to craft a response right now. "
                "Please try again in a moment."
            )
            logger.error(
                "Model invocation failed for session %s: %s",
                chat_session.id,
                exc,
            )
            await trace_service.add_step(
                db,
                run_id=run.id,
                step_type="model",
                label="Model call failed",
                input_payload=llm_request_payload,
                output_payload={"error": str(exc)},
            )
            break

        message_payload = response.get("message") or {}
        tool_calls = message_payload.get("tool_calls") or []
        assistant_content = (message_payload.get("content") or "").strip()
        trace_output_payload: Dict[str, object] = {
            "message": message_payload,
            "raw": response.get("raw"),
        }

        await trace_service.add_step(
            db,
            run_id=run.id,
            step_type="model",
            label="Assistant tool request" if tool_calls else "Assistant response",
            input_payload=llm_request_payload,
            output_payload=trace_output_payload,
        )

        assistant_entry: Dict[str, Any] = {
            "role": message_payload.get("role") or "assistant",
            "content": message_payload.get("content") or "",
        }
        if tool_calls:
            assistant_entry["tool_calls"] = tool_calls
        llm_messages.append(assistant_entry)

        if tool_calls and tools_payload:
            tool_iterations += 1
            if tool_iterations > max_tool_iterations:
                assistant_text = (
                    "I ran into a tool loop and had to stop. "
                    "Please refine your request."
                )
                logger.warning(
                    "Aborting tool loop for session %s after %d iterations",
                    chat_session.id,
                    tool_iterations,
                )
                break

            for call in tool_calls:
                function_payload = call.get("function") or {}
                function_name = function_payload.get("name") or ""
                raw_arguments = function_payload.get("arguments", {})

                if isinstance(raw_arguments, str):
                    try:
                        arguments = json.loads(raw_arguments)
                    except json.JSONDecodeError:
                        arguments = {"raw": raw_arguments}
                elif isinstance(raw_arguments, dict):
                    arguments = raw_arguments
                else:
                    arguments = {"value": raw_arguments}

                tool_info = tool_lookup.get(function_name)
                if not tool_info and function_name:
                    try:
                        server_name, tool_name = mcp_service.decode_tool_name(function_name)
                        tool_info = {"server_name": server_name, "tool_name": tool_name}
                    except ValueError:
                        tool_info = None

                try:
                    if not tool_info:
                        raise ValueError(f"Unknown tool '{function_name}'")
                    logger.info(
                        "Session %s invoking tool %s with arguments=%s",
                        chat_session.id,
                        function_name,
                        arguments,
                    )
                    tool_output = await mcp_service.execute(
                        tool_info["server_name"],
                        tool_info["tool_name"],
                        arguments if isinstance(arguments, dict) else {"value": arguments},
                    )
                except Exception as exc:  # pragma: no cover - defensive guard
                    error_text = f"Tool invocation failed: {exc}"
                    tool_output = {
                        "content": [{"type": "text", "text": error_text}],
                        "isError": True,
                        "text": error_text,
                    }
                    logger.exception(
                        "Tool execution failed in session %s for %s", chat_session.id, function_name
                    )

                label = function_name or ""
                if not label and tool_info:
                    label = f"{tool_info['server_name']}:{tool_info['tool_name']}"
                if not label:
                    label = "mcp"

                await trace_service.add_step(
                    db,
                    run_id=run.id,
                    step_type="mcp",
                    label=label,
                    input_payload={
                        "function": function_name,
                        "arguments": arguments,
                    },
                    output_payload=tool_output,
                )
                logger.info(
                    "Tool %s completed with isError=%s for session %s",
                    function_name,
                    tool_output.get("isError"),
                    chat_session.id,
                )

                tool_text = tool_output.get("text") or json.dumps(tool_output, ensure_ascii=False)
                tool_name_value = function_name or ""
                if not tool_name_value and tool_info:
                    tool_name_value = f"{tool_info['server_name']}:{tool_info['tool_name']}"

                llm_messages.append(
                    {
                        "role": "tool",
                        "tool_name": tool_name_value,
                        "content": tool_text,
                    }
                )

            continue

        assistant_text = assistant_content or assistant_text
        break

    if not assistant_text:
        assistant_text = (
            "I could not produce a response right now. "
            "Please try again or adjust your request."
        )
        logger.warning(
            "Assistant produced empty response for session %s; returning fallback text",
            chat_session.id,
        )

    assistant_message = Message(
        session_id=chat_session.id,
        role="assistant",
        content=assistant_text,
    )
    db.add(assistant_message)
    await trace_service.finish_run(db, run_id=run.id, status="completed")
    await db.commit()
    await db.refresh(assistant_message)

    return assistant_message, run.id


@router.post("/{session_id}/messages", response_model=MessageResponse)
async def post_message(
    session_id: str,
    content: str = Form(...),
    files: List[UploadFile] | None = File(default=None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    app_config=Depends(get_app_config),
    uploads_dir=Depends(get_uploads_directory),
):
    chat_session = await _get_session_for_user(db, current_user.id, session_id)
    rag_service = get_rag_service()
    trace_service = get_trace_service()
    ollama_service = get_ollama_service()
    mcp_service = get_mcp_service()
    assistant_message, run_id = await _process_user_turn(
        chat_session=chat_session,
        content=content,
        user=current_user,
        files=files,
        db=db,
        app_config=app_config,
        uploads_dir=uploads_dir,
        rag_service=rag_service,
        ollama_service=ollama_service,
        mcp_service=mcp_service,
        trace_service=trace_service,
    )

    return MessageResponse(
        id=assistant_message.id,
        role=assistant_message.role,
        content=assistant_message.content,
        created_at=assistant_message.created_at,
        run_id=run_id,
        edited_from_message_id=None,
    )


@router.patch("/{session_id}/messages/{message_id}", response_model=MessageResponse)
async def edit_message(
    session_id: str,
    message_id: str,
    payload: MessageEditRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    app_config=Depends(get_app_config),
    uploads_dir=Depends(get_uploads_directory),
):
    chat_session = await _get_session_for_user(db, current_user.id, session_id)
    message = await db.get(Message, message_id)
    if not message or message.session_id != chat_session.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Message not found")
    if message.role != "user":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Only user messages can be edited")

    stmt_last_user = (
        select(Message)
        .where(Message.session_id == chat_session.id, Message.role == "user")
        .order_by(Message.created_at.desc())
        .limit(1)
    )
    last_user_message = (await db.execute(stmt_last_user)).scalar_one_or_none()
    if not last_user_message or last_user_message.id != message.id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Only the latest user message can be edited")

    rag_service = get_rag_service()
    trace_service = get_trace_service()
    ollama_service = get_ollama_service()
    mcp_service = get_mcp_service()
    assistant_message, run_id = await _process_user_turn(
        chat_session=chat_session,
        content=payload.content,
        user=current_user,
        files=None,
        db=db,
        app_config=app_config,
        uploads_dir=uploads_dir,
        rag_service=rag_service,
        ollama_service=ollama_service,
        mcp_service=mcp_service,
        trace_service=trace_service,
        edited_from=message.id,
    )

    return MessageResponse(
        id=assistant_message.id,
        role=assistant_message.role,
        content=assistant_message.content,
        created_at=assistant_message.created_at,
        run_id=run_id,
        edited_from_message_id=None,
    )
