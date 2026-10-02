from contextlib import asynccontextmanager

from fastapi import FastAPI

from .config import get_settings
from .worker import start_in_thread
from .routers import auth, documents, gpu, jobs, matters


def create_app() -> FastAPI:
    s = get_settings()
    if s.app_env != "local" and len(s.session_secret) < 32:
        raise RuntimeError("SESSION_SECRET must be set (32+ chars) outside local development")

    @asynccontextmanager
    async def lifespan(_app):
        stop = start_in_thread() if s.run_worker else None
        yield
        if stop:
            stop.set()

    app = FastAPI(title="Legal AI", version="0.1.0", lifespan=lifespan)
    for r in (auth.router, matters.router, documents.router, jobs.router, gpu.router):
        app.include_router(r)

    @app.get("/healthz")
    def healthz():
        return {"ok": True}

    return app


app = create_app()
