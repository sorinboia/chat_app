from __future__ import annotations

import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.append(str(ROOT))

from backend.app.core.database import get_db_session, init_db
from backend.app.seed import seed_users


async def main() -> None:
    await init_db()
    async with get_db_session() as session:
        await seed_users(session)


if __name__ == "__main__":
    asyncio.run(main())
