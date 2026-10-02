import os
import tempfile

import psycopg
import pytest

BASE = os.environ.get("TEST_DB_ADMIN_URL", "postgresql://legalai:legalai-dev@localhost:5442/postgres")
TEST_DB = "legalai_test"
os.environ["DATABASE_URL"] = f"postgresql+psycopg://legalai:legalai-dev@localhost:5442/{TEST_DB}"
os.environ["STORAGE_DIR"] = tempfile.mkdtemp(prefix="legalai-test-")
os.environ["RUN_WORKER"] = "false"
os.environ["FAST_MODEL"] = "fast-m"
os.environ["DEEP_MODEL"] = "deep-m"
os.environ["GPU_NODE_TOKEN"] = "node-secret-for-tests-1234567890"
os.environ["GPU_NODE_ID"] = "test-node"

from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import text  # noqa: E402

from legalai import db as dbmod  # noqa: E402
from legalai.config import get_settings  # noqa: E402
from legalai.security import login_limiter  # noqa: E402


@pytest.fixture(scope="session", autouse=True)
def _database():
    with psycopg.connect(BASE, autocommit=True) as c:
        c.execute(f"DROP DATABASE IF EXISTS {TEST_DB} WITH (FORCE)")
        c.execute(f"CREATE DATABASE {TEST_DB}")
    import legalai.models  # noqa: F401
    dbmod.engine()
    with dbmod._engine.begin() as c:
        c.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
    dbmod.Base.metadata.create_all(dbmod._engine)
    yield


@pytest.fixture(autouse=True)
def _clean():
    with dbmod.engine().begin() as c:
        c.execute(text("TRUNCATE users, matters, audit_events, gpu_nodes, provider_usage, jobs, document_chunks, research_runs CASCADE"))
    login_limiter.reset()
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def client():
    from legalai.main import create_app
    return TestClient(create_app())


class Api:
    """Cookie-session client wrapper that attaches the CSRF header."""

    def __init__(self, app):
        self.c = TestClient(app)
        self.csrf = ""

    def _h(self):
        return {"x-csrf-token": self.csrf}

    def post(self, url, **kw):
        return self.c.post(url, headers=self._h(), **kw)

    def patch(self, url, **kw):
        return self.c.patch(url, headers=self._h(), **kw)

    def get(self, url, **kw):
        return self.c.get(url, **kw)


def make_user(app, email, admin_first=False, password="correct horse battery"):
    a = Api(app)
    r = a.c.post("/api/auth/bootstrap", json={"email": email, "password": password})
    assert r.status_code == 200, r.text
    a.csrf = r.json()["csrf_token"]
    return a


@pytest.fixture
def make_api():
    from legalai.main import create_app
    app = create_app()

    def _make(email):
        # first user is admin via bootstrap; others are created by that admin then log in
        if not hasattr(_make, "admin"):
            _make.admin = make_user(app, "admin@example.com")
        if email == "admin@example.com":
            return _make.admin
        r = _make.admin.post("/api/auth/users", json={"email": email, "password": "correct horse battery"})
        assert r.status_code == 200, r.text
        a = Api(app)
        r = a.c.post("/api/auth/login", json={"email": email, "password": "correct horse battery"})
        assert r.status_code == 200, r.text
        a.csrf = r.json()["csrf_token"]
        return a

    return _make
