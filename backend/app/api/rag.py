from __future__ import annotations

from typing import List

from fastapi import APIRouter, Depends, File, UploadFile, status

from ..core.database import AsyncSession
from ..core.dependencies import (
    get_current_user,
    get_db,
    get_rag_service,
    get_uploads_directory,
)
from ..models import Upload, User
from ..schemas import RAGChunkResponse, RAGQueryRequest, RAGQueryResponse, UploadResponse
from ..services.rag import RAGService
from ..services.upload_manager import delete_upload as delete_upload_record
from ..services.upload_manager import list_user_uploads, store_upload

router = APIRouter(prefix="/rag", tags=["rag"])


def _to_upload_response(upload: Upload) -> UploadResponse:
    return UploadResponse(
        id=upload.id,
        filename=upload.filename,
        mime=upload.mime,
        size_bytes=upload.size_bytes,
        created_at=upload.created_at,
    )

@router.get("/uploads", response_model=List[UploadResponse])
async def list_uploads(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    uploads = await list_user_uploads(
        db,
        user_id=current_user.id,
        session=None,
        include_session_uploads=True,
        include_global=True,
    )
    return [_to_upload_response(upload) for upload in uploads]


@router.post("/uploads", response_model=List[UploadResponse], status_code=status.HTTP_201_CREATED)
async def upload_files(
    files: List[UploadFile] = File(...),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    rag_service: RAGService = Depends(get_rag_service),
    uploads_dir=Depends(get_uploads_directory),
):
    stored: List[Upload] = []
    for file in files:
        if file is None:
            continue
        upload = await store_upload(
            file,
            uploads_dir=uploads_dir,
            user=current_user,
            db=db,
            rag_service=rag_service,
            session=None,
        )
        stored.append(upload)
    return [_to_upload_response(upload) for upload in stored]


@router.delete("/uploads/{upload_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_upload(
    upload_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    uploads_dir=Depends(get_uploads_directory),
):
    await delete_upload_record(
        upload_id,
        uploads_dir=uploads_dir,
        user=current_user,
        db=db,
    )


@router.post("/query", response_model=RAGQueryResponse)
async def query_rag(
    payload: RAGQueryRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    rag_service: RAGService = Depends(get_rag_service),
):
    uploads = await list_user_uploads(
        db,
        user_id=current_user.id,
        session=None,
        include_session_uploads=True,
        include_global=True,
    )
    if not uploads:
        return RAGQueryResponse(chunks=[])
    retrieved = await rag_service.retrieve(
        db,
        [upload.id for upload in uploads],
        payload.query,
        top_k=payload.top_k,
    )
    return RAGQueryResponse(
        chunks=[
            RAGChunkResponse(
                id=chunk.chunk_id,
                document_id=chunk.document_id,
                text=chunk.text,
                score=chunk.score,
                filename=chunk.upload_filename,
            )
            for chunk in retrieved
        ]
    )
