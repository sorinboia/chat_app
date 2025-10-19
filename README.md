cd frontend && npm run dev -- --host 0.0.0.0 --port 5174

uvicorn backend.app.main:app --reload --host 0.0.0.0 --port 8000 --log-level debug