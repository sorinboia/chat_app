from __future__ import annotations

import logging

from sqlalchemy import select

from .core.database import AsyncSession

from .models import User
from .utils.security import hash_password


DEMO_USERS = [
    {
        "email": "amber.lee@example.com",
        "full_name": "Amber Lee",
        "title": "Principal Solutions Engineer",
        "team": "Field Engineering",
        "avatar_url": "https://example.com/avatars/amber.png",
    },
    {
        "email": "derek.nguyen@example.com",
        "full_name": "Derek Nguyen",
        "title": "Senior Solutions Engineer",
        "team": "Field Engineering",
        "avatar_url": "https://example.com/avatars/derek.png",
    },
    {
        "email": "sonia.patel@example.com",
        "full_name": "Sonia Patel",
        "title": "Solutions Engineer",
        "team": "Customer Success",
        "avatar_url": "https://example.com/avatars/sonia.png",
    },
    {
        "email": "marcus.johnson@example.com",
        "full_name": "Marcus Johnson",
        "title": "Solutions Architect",
        "team": "Alliances",
        "avatar_url": "https://example.com/avatars/marcus.png",
    },
    {
        "email": "lina.rodriguez@example.com",
        "full_name": "Lina Rodriguez",
        "title": "Lead Solutions Engineer",
        "team": "Proof of Concept",
        "avatar_url": "https://example.com/avatars/lina.png",
    },
]

DEFAULT_PASSWORD = "DemoPass123!"


logger = logging.getLogger(__name__)


async def seed_users(session: AsyncSession) -> None:
    logger.info("Checking for existing demo users before seeding")
    result = await session.execute(select(User))
    if result.scalars().first():
        logger.info("Demo users already present; skipping seed")
        return
    logger.info("Seeding demo users into database")
    password_hash = hash_password(DEFAULT_PASSWORD)
    for payload in DEMO_USERS:
        user = User(
            email=payload["email"],
            password_hash=password_hash,
            full_name=payload.get("full_name"),
            title=payload.get("title"),
            team=payload.get("team"),
            avatar_url=payload.get("avatar_url"),
        )
        session.add(user)
    await session.commit()
    logger.info("Demo users seeded successfully")
