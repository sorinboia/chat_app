from __future__ import annotations

import datetime as dt
from typing import List, Optional

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Integer, LargeBinary, String, Text, UniqueConstraint
from sqlalchemy.dialects.sqlite import JSON as SQLiteJSON
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import Base, TimestampMixin, UUIDMixin


class User(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "users"

    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    full_name: Mapped[Optional[str]] = mapped_column(String(255))
    title: Mapped[Optional[str]] = mapped_column(String(255))
    team: Mapped[Optional[str]] = mapped_column(String(255))
    avatar_url: Mapped[Optional[str]] = mapped_column(String(512))

    sessions: Mapped[List["ChatSession"]] = relationship(back_populates="owner", cascade="all, delete-orphan")
    uploads: Mapped[List["Upload"]] = relationship(back_populates="user", cascade="all, delete-orphan")


class ChatSession(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "sessions"

    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    title: Mapped[str] = mapped_column(String(255), default="New Chat")
    model_id: Mapped[Optional[str]] = mapped_column(String(255))
    persona_id: Mapped[Optional[str]] = mapped_column(String(255))
    rag_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    streaming_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    enabled_mcp_servers: Mapped[list[str]] = mapped_column(SQLiteJSON, default=list)

    owner: Mapped[User] = relationship(back_populates="sessions")
    messages: Mapped[List["Message"]] = relationship(back_populates="session", cascade="all, delete-orphan")
    runs: Mapped[List["TraceRun"]] = relationship(back_populates="session", cascade="all, delete-orphan")
    uploads: Mapped[List["Upload"]] = relationship(back_populates="session")


class Message(Base, UUIDMixin):
    __tablename__ = "messages"

    session_id: Mapped[str] = mapped_column(ForeignKey("sessions.id", ondelete="CASCADE"), nullable=False, index=True)
    role: Mapped[str] = mapped_column(String(32), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=dt.datetime.utcnow)
    edited_from_message_id: Mapped[Optional[str]] = mapped_column(String(36))

    session: Mapped[ChatSession] = relationship(back_populates="messages")


class Upload(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "uploads"

    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    session_id: Mapped[Optional[str]] = mapped_column(ForeignKey("sessions.id", ondelete="SET NULL"), nullable=True, index=True)
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    path: Mapped[str] = mapped_column(String(512), nullable=False)
    mime: Mapped[str] = mapped_column(String(128), nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)

    user: Mapped[User] = relationship(back_populates="uploads")
    session: Mapped[Optional[ChatSession]] = relationship(back_populates="uploads")
    documents: Mapped[List["RAGDocument"]] = relationship(back_populates="upload", cascade="all, delete-orphan")


class TraceRun(Base, UUIDMixin):
    __tablename__ = "trace_runs"

    session_id: Mapped[str] = mapped_column(ForeignKey("sessions.id", ondelete="CASCADE"), nullable=False, index=True)
    started_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=dt.datetime.utcnow)
    finished_at: Mapped[Optional[dt.datetime]] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(String(32), default="pending")
    model_id: Mapped[Optional[str]] = mapped_column(String(255))
    total_tokens: Mapped[Optional[int]] = mapped_column(Integer)
    prompt_tokens: Mapped[Optional[int]] = mapped_column(Integer)
    completion_tokens: Mapped[Optional[int]] = mapped_column(Integer)
    latency_ms: Mapped[Optional[int]] = mapped_column(Integer)

    session: Mapped[ChatSession] = relationship(back_populates="runs")
    steps: Mapped[List["TraceStep"]] = relationship(back_populates="run", cascade="all, delete-orphan")


class TraceStep(Base, UUIDMixin):
    __tablename__ = "trace_steps"

    run_id: Mapped[str] = mapped_column(ForeignKey("trace_runs.id", ondelete="CASCADE"), nullable=False, index=True)
    ts: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=dt.datetime.utcnow)
    type: Mapped[str] = mapped_column(String(32), nullable=False)
    label: Mapped[Optional[str]] = mapped_column(String(255))
    input_json: Mapped[Optional[dict]] = mapped_column(SQLiteJSON)
    output_json: Mapped[Optional[dict]] = mapped_column(SQLiteJSON)
    latency_ms: Mapped[Optional[int]] = mapped_column(Integer)

    run: Mapped[TraceRun] = relationship(back_populates="steps")


class RAGDocument(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "rag_documents"

    upload_id: Mapped[str] = mapped_column(ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False)
    doc_type: Mapped[str] = mapped_column(String(16), nullable=False)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    meta_json: Mapped[dict] = mapped_column(SQLiteJSON, default=dict)

    upload: Mapped[Upload] = relationship(back_populates="documents")
    chunks: Mapped[List["RAGChunk"]] = relationship(back_populates="document", cascade="all, delete-orphan")


class RAGChunk(Base, UUIDMixin):
    __tablename__ = "rag_chunks"
    __table_args__ = (UniqueConstraint("document_id", "chunk_index"),)

    document_id: Mapped[str] = mapped_column(ForeignKey("rag_documents.id", ondelete="CASCADE"), nullable=False)
    chunk_index: Mapped[int] = mapped_column(Integer, nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    embedding: Mapped[Optional[bytes]] = mapped_column(LargeBinary)
    token_count: Mapped[Optional[int]] = mapped_column(Integer)

    document: Mapped[RAGDocument] = relationship(back_populates="chunks")


class ConfigCache(Base, UUIDMixin):
    __tablename__ = "config_cache"

    key: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    json: Mapped[dict] = mapped_column(SQLiteJSON, nullable=False)
    loaded_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=dt.datetime.utcnow)
    version: Mapped[str] = mapped_column(String(32), nullable=False)
