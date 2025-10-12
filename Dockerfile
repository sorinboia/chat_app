# syntax=docker/dockerfile:1

##
## Frontend build stage
##
FROM node:20-bullseye-slim AS frontend-builder

WORKDIR /frontend

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend ./
RUN npm run build

##
## Backend dependencies build stage
##
FROM python:3.11-slim AS backend-deps

WORKDIR /app

ENV PIP_NO_CACHE_DIR=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential libffi-dev libssl-dev \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

##
## Final runtime image
##
FROM python:3.11-slim

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app

RUN apt-get update \
    && apt-get install -y --no-install-recommends libffi8 libssl3 curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=backend-deps /install /usr/local
COPY backend ./backend
COPY config ./config
COPY data ./data
COPY app.db ./app.db
COPY --from=frontend-builder /frontend/dist ./frontend/dist

RUN mkdir -p data/uploads

EXPOSE 8000

CMD ["uvicorn", "backend.app.main:app", "--host", "0.0.0.0", "--port", "8000"]
