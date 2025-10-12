from __future__ import annotations

import logging
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .api import auth, config as config_router, models as models_router, rag as rag_router, sessions, traces
from .core.database import lifespan_context
from .core.dependencies import get_config_service

app = FastAPI(
    title="AI Chatbot Demo App",
    version="0.1.0",
    lifespan=lifespan_context,
)

logger = logging.getLogger(__name__)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(config_router.router)
app.include_router(models_router.router)
app.include_router(rag_router.router)
app.include_router(sessions.router)
app.include_router(traces.router)


@app.on_event("startup")
async def startup_event() -> None:
    logger.info("Starting up application; loading configuration")
    config_service = get_config_service()
    config_service.load()
    from .core.database import get_db_session

    async with get_db_session() as session:
        await config_service.cache_to_db(session)
    logger.info("Startup initialization complete")


@app.get("/health")
async def health():
    return {"status": "ok"}


def _safe_file_response(path: str) -> FileResponse:
    file_path = _frontend_dist / path
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(status_code=404)
    return FileResponse(file_path)


_frontend_dist = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if _frontend_dist.exists():
    assets_dir = _frontend_dist / "assets"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=assets_dir), name="frontend-assets")

    sounds_dir = _frontend_dist / "sounds"
    if sounds_dir.exists():
        app.mount("/sounds", StaticFiles(directory=sounds_dir), name="frontend-sounds")

    @app.get("/", include_in_schema=False)
    async def serve_index() -> FileResponse:
        return _safe_file_response("index.html")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_spa(full_path: str) -> FileResponse:
        candidate = _frontend_dist / full_path
        candidate_resolved = candidate.resolve()
        try:
            candidate_resolved.relative_to(_frontend_dist.resolve())
        except ValueError:
            raise HTTPException(status_code=404)

        if candidate_resolved.is_file():
            return FileResponse(candidate_resolved)

        return _safe_file_response("index.html")
