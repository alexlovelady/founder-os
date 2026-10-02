from contextlib import asynccontextmanager

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse

from .config import get_settings
from .worker import start_in_thread
from .routers import auth, documents, gpu, jobs, matters, research, search


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
    for r in (auth.router, matters.router, documents.router, jobs.router, gpu.router, search.router, research.router):
        app.include_router(r)

    @app.get("/healthz")
    def healthz():
        return {"ok": True}

    # Single-page UI built from apps/web (copied to ./static in the Docker image).
    static = Path(__file__).resolve().parent.parent / "static"
    if static.is_dir():
        @app.get("/{path:path}", include_in_schema=False)
        def spa(path: str):
            if path.startswith("api/"):
                raise HTTPException(404)
            f = (static / path).resolve()
            if path and static in f.parents and f.is_file():
                return FileResponse(f, headers={"Cache-Control": "public, max-age=31536000, immutable"}
                                    if path.startswith("assets/") else {})
            return FileResponse(static / "index.html", headers={"Cache-Control": "no-store"})

    return app


app = create_app()
