FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml .
COPY legalai legalai
COPY migrations migrations
COPY alembic.ini .
RUN pip install --no-cache-dir .
CMD ["sh", "-c", "alembic upgrade head && uvicorn legalai.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
