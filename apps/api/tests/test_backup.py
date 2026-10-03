import json
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import pytest

from legalai.backup import Pg, apply_retention, is_due, latest_backup, make_backup, parse_url, verify_backup
from legalai.config import get_settings
from tests.test_retrieval import drain, mk_matter, upload

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "scripts"))
import pull_backup  # noqa: E402

DOCKER = "legalai-db-1"
TOKEN = "backup-token-for-tests-123456"


def docker_up() -> bool:
    try:
        return subprocess.run(["docker", "exec", DOCKER, "true"], capture_output=True, timeout=10).returncode == 0
    except Exception:  # noqa: BLE001
        return False


needs_db_tools = pytest.mark.skipif(not docker_up(), reason="needs the docker dev database for pg_dump and pg_restore")


def app_pg():
    return Pg(parse_url(get_settings().database_url), docker=DOCKER)


def test_parse_url():
    c = parse_url("postgresql+psycopg://legalai:p%40ss@db.internal:5433/legalai")
    assert c == {"user": "legalai", "password": "p@ss", "host": "db.internal", "port": "5433", "db": "legalai"}


def test_retention_keeps_recent_and_weekly(tmp_path):
    base = datetime(2026, 9, 1, 3, 0, 0)
    for i in range(40):
        d = tmp_path / f"backup-{(base + timedelta(days=i)).strftime('%Y%m%d-%H%M%S')}"
        d.mkdir()
        (d / "manifest.json").write_text("{}")
    removed = apply_retention(tmp_path, keep_daily=7, keep_weekly=4)
    left = sorted(p.name for p in tmp_path.glob("backup-*"))
    assert len(left) <= 11 and len(removed) == 40 - len(left)
    newest = (base + timedelta(days=39)).strftime("backup-%Y%m%d-%H%M%S")
    assert newest in left and all(n in left for n in [(base + timedelta(days=i)).strftime("backup-%Y%m%d-%H%M%S") for i in range(33, 40)])


def test_is_due_by_age(tmp_path):
    assert is_due(tmp_path, 24)
    d = tmp_path / "backup-20260101-000000"
    d.mkdir()
    (d / "manifest.json").write_text(json.dumps({"created_at": datetime.now(timezone.utc).isoformat()}))
    assert not is_due(tmp_path, 24) and latest_backup(tmp_path) == d
    (d / "manifest.json").write_text(json.dumps({"created_at": (datetime.now(timezone.utc) - timedelta(hours=30)).isoformat()}))
    assert is_due(tmp_path, 24)


@needs_db_tools
def test_backup_and_verify_roundtrip_detects_corruption(make_api, tmp_path):
    a = make_api("admin@example.com")
    m = mk_matter(a)
    upload(a, m["id"], "a.txt", b"Contract text for backup test.")
    upload(a, m["id"], "b.txt", b"Another document for the backup test.")
    drain()
    storage = Path(get_settings().storage_dir)
    p = app_pg()
    out = make_backup(p, tmp_path, storage, include_storage=True)
    man = json.loads((out / "manifest.json").read_text())
    assert man["row_counts"]["documents"] == 2 and len(man["storage_files"]) == 2 and man["storage_archive"]["sha256"]
    assert verify_backup(p, out, storage) == []
    out2 = make_backup(p, tmp_path, storage, include_storage=False)
    f = storage / next(x["key"] for x in man["storage_files"] if x["key"].endswith("a.txt"))
    f.write_bytes(f.read_bytes() + b"tampered")
    assert any("hash mismatch" in x for x in verify_backup(p, out2, storage))
    (out / "db.dump").write_bytes(b"garbage")
    assert verify_backup(p, out, storage) == ["db.dump hash does not match manifest"]


def run_scheduled(make_api, tmp_path, monkeypatch):
    from legalai.backup_job import enqueue_due_backups, run_backup
    monkeypatch.setenv("BACKUP_ENABLED", "true")
    monkeypatch.setenv("BACKUP_DIR", str(tmp_path / "bk"))
    monkeypatch.setenv("BACKUP_TOKEN", TOKEN)
    get_settings.cache_clear()
    s = get_settings()
    a = make_api("admin@example.com")
    bob = make_api("bob@example.com")
    m = mk_matter(a)
    upload(a, m["id"], "a.txt", b"Contract text for backup test.")
    drain()
    assert enqueue_due_backups(s) == 1 and enqueue_due_backups(s) == 0
    assert run_backup(s, pg=app_pg())["verified"] is True
    return a, bob


@needs_db_tools
def test_scheduled_job_and_backup_endpoint_access_control(make_api, tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from legalai.main import create_app
    a, bob = run_scheduled(make_api, tmp_path, monkeypatch)
    H = {"X-Backup-Token": TOKEN}
    assert a.c.get("/api/admin/backup/manifest").status_code == 200
    assert bob.c.get("/api/admin/backup/manifest").status_code == 403
    anon = TestClient(create_app())
    assert anon.get("/api/admin/backup/manifest").status_code == 401
    assert anon.get("/api/admin/backup/manifest", headers={"X-Backup-Token": "wrong"}).status_code == 401
    mf = anon.get("/api/admin/backup/manifest", headers=H).json()
    assert mf["latest"]["verified_at"] and mf["latest"]["verify_problems"] == [] and len(mf["files"]) == 1
    assert anon.post("/api/admin/backup", headers=H).status_code in (401, 403)      # the token is read-only
    key = mf["files"][0]["key"]
    assert anon.get("/api/admin/backup/file", params={"key": key}, headers=H).content == b"Contract text for backup test."
    assert anon.get("/api/admin/backup/file", params={"key": "../../etc/passwd"}, headers=H).status_code == 404
    assert anon.get("/api/admin/backup/db", headers=H).content[:5] == b"PGDMP"
    h = a.get("/api/admin/health").json()
    assert h["checks"]["backup"]["ok"] and h["checks"]["backup"]["verified"]


@needs_db_tools
def test_offsite_puller_mirrors_verifies_and_self_heals(make_api, tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from legalai.main import create_app
    run_scheduled(make_api, tmp_path, monkeypatch)
    anon = TestClient(create_app())

    class Adapter(httpx.BaseTransport):
        def handle_request(self, request):
            path = request.url.raw_path.decode()
            r = anon.get(path, headers={"X-Backup-Token": TOKEN})
            return httpx.Response(r.status_code, content=r.content)

    dest = tmp_path / "offsite"
    with httpx.Client(base_url="http://srv", transport=Adapter()) as c:
        rep = pull_backup.pull(c, dest, keep=2)
        assert rep["problems"] == [] and rep["files_downloaded"] == 1 and rep["db"].endswith(".dump")
        again = pull_backup.pull(c, dest, keep=2)
        assert again["files_downloaded"] == 0 and again["files_ok"] == 1
        mirrored = next((dest / "files").rglob("a.txt"))
        assert mirrored.read_bytes() == b"Contract text for backup test."
        mirrored.write_bytes(b"corrupted locally")
        fixed = pull_backup.pull(c, dest)
        assert fixed["files_downloaded"] == 1 and mirrored.read_bytes() == b"Contract text for backup test."
