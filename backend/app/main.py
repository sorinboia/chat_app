from __future__ import annotations

import logging
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
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

_frontend_dist = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if _frontend_dist.exists():
    app.mount("/", StaticFiles(directory=_frontend_dist, html=True), name="frontend")


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
