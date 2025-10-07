from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import List, Sequence, Tuple

from sqlalchemy import Select, select
from sqlalchemy.orm import selectinload

from ..core.database import AsyncSession

from ..core.config import RagConfig
from ..models import RAGChunk, RAGDocument, Upload

SUPPORTED_TEXT_TYPES = {".txt", ".md", ".mdx"}


@dataclass
class RetrievedChunk:
    chunk_id: str
    document_id: str
    text: str
    score: float
    upload_filename: str | None


class RAGService:
    def __init__(self, config: RagConfig, uploads_dir: Path) -> None:
        self.config = config
        self.uploads_dir = uploads_dir

    async def ingest_upload(self, session: AsyncSession, upload: Upload, mime: str) -> None:
        path = Path(upload.path)
        suffix = path.suffix.lower()
        text = self._read_text(path)
        document = RAGDocument(
            upload_id=upload.id,
            doc_type=suffix.lstrip("."),
            title=upload.filename,
            meta_json={"mime": mime},
        )
        session.add(document)
        await session.flush()

        chunks = self._chunk_text(text)
        for idx, chunk in enumerate(chunks):
            rag_chunk = RAGChunk(
                document_id=document.id,
                chunk_index=idx,
                text=chunk,
                embedding=None,
                token_count=len(chunk.split()),
            )
            session.add(rag_chunk)
        await session.commit()

    async def retrieve(self, session: AsyncSession, upload_ids: Sequence[str], query: str, *, top_k: int | None = None) -> List[RetrievedChunk]:
        if not upload_ids:
            return []
        stmt: Select[RAGChunk] = (
            select(RAGChunk)
            .options(selectinload(RAGChunk.document))
            .join(RAGDocument)
            .where(RAGDocument.upload_id.in_(upload_ids))
        )
        result = await session.execute(stmt)
        chunks: Sequence[RAGChunk] = result.scalars().all()
        scores: List[Tuple[RAGChunk, float]] = []
        for chunk in chunks:
            score = self._score(query, chunk.text)
            if score > 0:
                scores.append((chunk, score))
        scores.sort(key=lambda item: item[1], reverse=True)
        limit = top_k or self.config.top_k
        limited = scores[:limit]
        retrieved: List[RetrievedChunk] = []
        for chunk, score in limited:
            retrieved.append(
                RetrievedChunk(
                    chunk_id=chunk.id,
                    document_id=chunk.document_id,
                    text=chunk.text,
                    score=score,
                    upload_filename=chunk.document.title if chunk.document else None,
                )
            )
        return retrieved

    def _read_text(self, path: Path) -> str:
        suffix = path.suffix.lower()
        if suffix in SUPPORTED_TEXT_TYPES:
            return path.read_text("utf-8", errors="ignore")
        # fallback to simple binary decode
        return path.read_bytes().decode("utf-8", errors="ignore")

    def _chunk_text(self, text: str) -> List[str]:
        words = text.split()
        chunk_size = max(1, self.config.chunk_size_tokens)
        overlap = max(0, self.config.chunk_overlap_tokens)
        chunks: List[str] = []
        start = 0
        while start < len(words):
            end = min(len(words), start + chunk_size)
            chunk_words = words[start:end]
            chunks.append(" ".join(chunk_words))
            if end == len(words):
                break
            start = max(0, end - overlap)
        if not chunks:
            chunks.append(text)
        return chunks

    def _score(self, query: str, text: str) -> float:
        query_terms = self._normalize(query)
        text_terms = self._normalize(text)
        if not query_terms or not text_terms:
            return 0.0
        intersection = query_terms.intersection(text_terms)
        if not intersection:
            return 0.0
        return len(intersection) / math.sqrt(len(query_terms) * len(text_terms))

    def _normalize(self, text: str) -> set[str]:
        return {token.lower() for token in text.split() if token.strip()}
