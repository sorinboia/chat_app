from __future__ import annotations

import os
import uuid
from pathlib import Path
from typing import Iterable, List, Optional

from fastapi import HTTPException, UploadFile, status
from sqlalchemy import Select, or_, select

from ..core.database import AsyncSession
from ..models import ChatSession, Upload, User
from .rag import RAGService

ALLOWED_SUFFIXES = {".pdf", ".md", ".txt", ".docx", ".mdx"}
MAX_UPLOAD_SIZE_BYTES = 5 * 1024 * 1024


async def store_upload(
    file: UploadFile,
    *,
    uploads_dir: os.PathLike[str],
    user: User,
    db: AsyncSession,
    rag_service: RAGService,
    session: Optional[ChatSession] = None,
) -> Upload:
    filename = file.filename or "upload.bin"
    suffix = os.path.splitext(filename)[1].lower()
    if suffix not in ALLOWED_SUFFIXES:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Unsupported file type: {suffix}")

    data = await file.read()
    if len(data) > MAX_UPLOAD_SIZE_BYTES:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="File exceeds 5 MB limit")

    uploads_dir = os.fspath(uploads_dir)
    os.makedirs(uploads_dir, exist_ok=True)
    stored_name = f"{uuid.uuid4()}_{filename}"
    stored_path = os.path.join(uploads_dir, stored_name)
    with open(stored_path, "wb") as f:
        f.write(data)

    upload = Upload(
        user_id=user.id,
        session_id=session.id if session else None,
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


async def list_user_uploads(
    db: AsyncSession,
    user_id: str,
    *,
    session: Optional[ChatSession] = None,
    include_session_uploads: bool = True,
    include_global: bool = True,
) -> List[Upload]:
    criteria = []
    if include_session_uploads and session is not None:
        criteria.append(Upload.session_id == session.id)
    if include_global:
        criteria.append(Upload.session_id.is_(None))
    if not criteria:
        return []

    stmt: Select[Upload] = (
        select(Upload)
        .where(Upload.user_id == user_id)
        .where(or_(*criteria))
        .order_by(Upload.created_at.desc())
    )
    result = await db.execute(stmt)
    uploads: Iterable[Upload] = result.scalars().all()
    return list(uploads)


async def delete_upload(
    upload_id: str,
    *,
    uploads_dir: os.PathLike[str],
    user: User,
    db: AsyncSession,
) -> None:
    stmt: Select[Upload] = select(Upload).where(Upload.id == upload_id, Upload.user_id == user.id)
    result = await db.execute(stmt)
    upload = result.scalar_one_or_none()
    if upload is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Upload not found")

    uploads_dir_path = Path(uploads_dir)
    file_path = Path(upload.path)
    try:
        file_path.relative_to(uploads_dir_path)
    except ValueError:
        file_path = None

    await db.delete(upload)
    await db.commit()

    if file_path is not None and file_path.exists():
        try:
            file_path.unlink()
        except OSError:
            # Ignore filesystem errors after database cleanup
            pass
