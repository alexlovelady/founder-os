# Build context is the repository root (Railway uploads from the root; compose uses context: .)
FROM node:22-slim AS web
WORKDIR /web
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci
COPY apps/web .
RUN npm run build

FROM python:3.12-slim
# tesseract: OCR for scanned documents. postgresql-client-16: scheduled backups (pg_dump must match the server major version).
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates gnupg tesseract-ocr tesseract-ocr-eng \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /usr/share/keyrings/pgdg.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] http://apt.postgresql.org/pub/repos/apt $(. /etc/os-release && echo $VERSION_CODENAME)-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update && apt-get install -y --no-install-recommends postgresql-client-16 \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY apps/api/pyproject.toml .
COPY apps/api/legalai legalai
COPY apps/api/migrations migrations
COPY apps/api/alembic.ini .
RUN pip install --no-cache-dir .
COPY --from=web /web/dist static
CMD ["sh", "-c", "alembic upgrade head && uvicorn legalai.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
