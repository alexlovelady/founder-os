# Build context is the repository root (Railway uploads from the root; compose uses context: .)
FROM node:22-slim AS web
WORKDIR /web
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci
COPY apps/web .
RUN npm run build

FROM python:3.12-slim
WORKDIR /app
COPY apps/api/pyproject.toml .
COPY apps/api/legalai legalai
COPY apps/api/migrations migrations
COPY apps/api/alembic.ini .
RUN pip install --no-cache-dir .
COPY --from=web /web/dist static
CMD ["sh", "-c", "alembic upgrade head && uvicorn legalai.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
