from __future__ import annotations

import asyncio
import functools
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator, Callable, TypeVar

from sqlalchemy import create_engine
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from ..models import Base

BASE_DIR = Path(__file__).resolve().parents[3]
DB_PATH = BASE_DIR / "app.db"
DATABASE_URL = f"sqlite:///{DB_PATH.as_posix()}"

_engine: Engine | None = None
_session_factory: sessionmaker[Session] | None = None
_executor: ThreadPoolExecutor | None = None

T = TypeVar("T")


def get_engine() -> Engine:
    global _engine, _session_factory
    if _engine is None:
        _engine = create_engine(
            DATABASE_URL,
            echo=False,
            future=True,
            connect_args={"check_same_thread": False},
        )
        _session_factory = sessionmaker(bind=_engine, expire_on_commit=False)
    return _engine


def get_session_factory() -> sessionmaker[Session]:
    global _session_factory
    if _session_factory is None:
        get_engine()
    assert _session_factory is not None
    return _session_factory


def _get_executor() -> ThreadPoolExecutor:
    global _executor
    if _executor is None:
        _executor = ThreadPoolExecutor(max_workers=8)
    return _executor


async def run_sync(func: Callable[..., T], /, *args, **kwargs) -> T:
    loop = asyncio.get_running_loop()
    executor = _get_executor()
    partial = functools.partial(func, *args, **kwargs)
    future = executor.submit(partial)
    return await asyncio.wrap_future(future, loop=loop)


class AsyncSession:
    def __init__(self, session: Session) -> None:
        self._session = session

    def add(self, instance) -> None:  # type: ignore[no-untyped-def]
        self._session.add(instance)

    def add_all(self, instances) -> None:  # type: ignore[no-untyped-def]
        self._session.add_all(instances)

    async def execute(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        return await run_sync(self._session.execute, *args, **kwargs)

    async def scalar(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        return await run_sync(self._session.scalar, *args, **kwargs)

    async def commit(self) -> None:
        await run_sync(self._session.commit)

    async def flush(self) -> None:
        await run_sync(self._session.flush)

    async def refresh(self, instance) -> None:  # type: ignore[no-untyped-def]
        await run_sync(self._session.refresh, instance)

    async def delete(self, instance) -> None:  # type: ignore[no-untyped-def]
        await run_sync(self._session.delete, instance)

    async def get(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        return await run_sync(self._session.get, *args, **kwargs)

    async def close(self) -> None:
        await run_sync(self._session.close)

    async def rollback(self) -> None:
        await run_sync(self._session.rollback)

    @property
    def sync_session(self) -> Session:
        return self._session

    def __getattr__(self, item):
        return getattr(self._session, item)


async def _shutdown_executor() -> None:
    global _executor
    if _executor is not None:
        _executor.shutdown(wait=False)
        _executor = None


@asynccontextmanager
async def lifespan_context(app):  # type: ignore[unused-argument]
    engine = get_engine()
    await run_sync(Base.metadata.create_all, engine)
    try:
        yield
    finally:
        await run_sync(engine.dispose)
        await _shutdown_executor()


async def init_db(drop_existing: bool = False) -> None:
    engine = get_engine()
    if drop_existing:
        await run_sync(Base.metadata.drop_all, engine)
    await run_sync(Base.metadata.create_all, engine)


@asynccontextmanager
async def get_db_session() -> AsyncIterator[AsyncSession]:
    session_factory = get_session_factory()
    session = session_factory()
    wrapper = AsyncSession(session)
    try:
        yield wrapper
    finally:
        await wrapper.close()


async def run_in_session(coro):
    async with get_db_session() as session:
        return await coro(session)
