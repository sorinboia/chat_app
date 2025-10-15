## General

Always use PRD.md to design the application.
If design changes make sure you edit the PRD.md, do this only after the user approves it.

User browsermcp MCP in order to test the app that you create.
Use context7 MCP to get up to date documentation.

You are in charge of testing and running the app.
For testing the UI use browsermcp.
When testing the backend endpoint use curl.

The backend and front end server are already running and when reload when there are config changes.
The backend is available at 0.0.0.0:8000 and the frontend at 0.0.0.0:5174 .





After you have finished an important step or fixed an issue do a git commit.








## Conventions for Running Python

- Do **not** use shell here-documents (`<<'PY' ... PY`) when writing inline Python.
- Instead, always create a standalone script file under `tmp/` (or the project root).
- Use the following pattern:

  1. Write the Python code into `tmp/<task_name>.py`.
  2. Run it with:
     ```bash
     PYTHONUNBUFFERED=1 python -u tmp/<task_name>.py
     ```

- Example (seeding users):

  ```bash
  cat > tmp/seed_users.py <<'EOF'
  import asyncio
  from backend.app.core.database import get_db_session
  from backend.app.seed import seed_users

  async def main():
      async with get_db_session() as session:
          await seed_users(session)

  if __name__ == "__main__":
      asyncio.run(main())
  EOF

  PYTHONUNBUFFERED=1 python -u tmp/seed_users.py
  