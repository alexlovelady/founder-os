import io
import zipfile

from legalai.db import session_scope
from legalai.models import AuditEvent


def new_matter(a, **kw):
    r = a.post("/api/matters", json={"name": "M", **kw})
    assert r.status_code == 201, r.text
    return r.json()


def test_bootstrap_once_and_csrf(make_api):
    admin = make_api("admin@example.com")
    r = admin.c.post("/api/auth/bootstrap", json={"email": "x@example.com", "password": "correct horse battery"})
    assert r.status_code == 403
    # state-changing request without CSRF header is rejected
    r = admin.c.post("/api/matters", json={"name": "m"})
    assert r.status_code == 403
    assert admin.post("/api/matters", json={"name": "m"}).status_code == 201


def test_unauthenticated_rejected(client):
    assert client.get("/api/matters").status_code == 401


def test_login_failure_and_rate_limit(make_api):
    admin = make_api("admin@example.com")
    for _ in range(10):
        assert admin.c.post("/api/auth/login", json={"email": "admin@example.com", "password": "bad"}).status_code == 401
    assert admin.c.post("/api/auth/login", json={"email": "admin@example.com", "password": "bad"}).status_code == 429


def test_matter_isolation_and_admin_has_no_content_access(make_api):
    admin = make_api("admin@example.com")
    alice = make_api("alice@example.com")
    bob = make_api("bob@example.com")
    m = new_matter(alice)
    assert alice.get(f"/api/matters/{m['id']}").status_code == 200
    for who in (bob, admin):
        assert who.get(f"/api/matters/{m['id']}").status_code == 404
        assert who.get(f"/api/matters/{m['id']}/documents").status_code == 404
        assert who.get(f"/api/matters/{m['id']}/audit").status_code == 404
        assert who.patch(f"/api/matters/{m['id']}", json={"name": "x"}).status_code == 404
    assert [x["id"] for x in bob.get("/api/matters").json()] == []


def test_local_only_forbids_external_settings(make_api):
    a = make_api("admin@example.com")
    r = a.post("/api/matters", json={"name": "m", "privacy_mode": "local_only", "llm_fallback_mode": "allowed"})
    assert r.status_code == 422
    r = a.post("/api/matters", json={"name": "m", "privacy_mode": "local_only", "external_embedding_enabled": True})
    assert r.status_code == 422
    m = new_matter(a, privacy_mode="standard", llm_fallback_mode="allowed", external_embedding_enabled=True)
    r = a.patch(f"/api/matters/{m['id']}", json={"privacy_mode": "local_only"})
    assert r.status_code == 200
    assert r.json()["llm_fallback_mode"] == "disabled" and r.json()["external_embedding_enabled"] is False
    r = a.patch(f"/api/matters/{m['id']}", json={"llm_fallback_mode": "allowed"})
    assert r.status_code == 422


def test_default_privacy_mode_is_private(make_api):
    a = make_api("admin@example.com")
    m = new_matter(a)
    assert m["privacy_mode"] == "private" and m["external_embedding_enabled"] is False


def _docx():
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w") as z:
        z.writestr("word/document.xml", "<w:document/>")
    return b.getvalue()


def test_upload_validation_hash_versions_and_ingest(make_api):
    import asyncio
    from legalai.jobs.runner import process_one
    a = make_api("admin@example.com")
    m = new_matter(a)
    up = lambda name, data, **f: a.post("/api/documents", data={"matter_id": m["id"], **f},
                                       files={"file": (name, data)})
    assert up("evil.exe", b"MZ").status_code == 422
    assert up("fake.pdf", b"not a pdf").status_code == 422
    assert up("fake.docx", b"not a zip").status_code == 422
    r = up("../../etc/pass wd.pdf", b"%PDF-1.4 hello")
    assert r.status_code == 201
    d = r.json()
    import hashlib
    assert d["current_version"]["sha256"] == hashlib.sha256(b"%PDF-1.4 hello").hexdigest()
    assert "/" not in d["current_version"]["filename"] and ".." not in d["current_version"]["filename"]
    r2 = up("v2.docx", _docx(), document_id=d["id"])
    assert r2.json()["current_version"]["version_number"] == 2
    assert len(a.get(f"/api/documents/{d['id']}/versions").json()) == 2
    # ingest job verifies stored hash
    asyncio.run(process_one())
    asyncio.run(process_one())
    vs = a.get(f"/api/documents/{d['id']}/versions").json()
    assert {v["status"] for v in vs} == {"verified"}
    dl = a.get(f"/api/documents/{d['id']}/versions/{vs[0]['id']}/download")
    assert dl.content == b"%PDF-1.4 hello"


def test_upload_size_limit_and_viewer_cannot_upload(make_api, monkeypatch):
    monkeypatch.setenv("MAX_UPLOAD_MB", "1")
    from legalai.config import get_settings
    get_settings.cache_clear()
    a = make_api("admin@example.com")
    m = new_matter(a)
    big = b"a" * (1024 * 1024 + 10)
    r = a.post("/api/documents", data={"matter_id": m["id"]}, files={"file": ("big.txt", big)})
    assert r.status_code == 413


def test_document_access_requires_matter_membership(make_api):
    alice, bob = make_api("alice@example.com"), make_api("bob@example.com")
    m = new_matter(alice)
    d = alice.post("/api/documents", data={"matter_id": m["id"]}, files={"file": ("a.txt", b"hi")}).json()
    assert bob.get(f"/api/documents/{d['id']}").status_code == 404
    assert bob.get(f"/api/documents/{d['id']}/versions").status_code == 404
    vid = d["current_version"]["id"]
    assert bob.get(f"/api/documents/{d['id']}/versions/{vid}/download").status_code == 404
    assert bob.post("/api/documents", data={"matter_id": m["id"]}, files={"file": ("a.txt", b"hi")}).status_code == 404


def test_audit_trail_written(make_api):
    a = make_api("admin@example.com")
    m = new_matter(a)
    a.post("/api/documents", data={"matter_id": m["id"]}, files={"file": ("a.txt", b"hi")})
    actions = {e["action"] for e in a.get(f"/api/matters/{m['id']}/audit").json()}
    assert {"matter.created", "document.uploaded", "job.enqueued"} <= actions


def test_heartbeat_requires_node_token_and_status(make_api):
    a = make_api("admin@example.com")
    hb = {"node_id": "test-node", "status": "online", "gpu": "RTX 5070 Ti", "models": ["fast-m"], "active_jobs": 0}
    assert a.c.post("/api/gpu/heartbeat", json=hb).status_code == 401
    assert a.c.post("/api/gpu/heartbeat", json=hb, headers={"Authorization": "Bearer wrong"}).status_code == 401
    ok = a.c.post("/api/gpu/heartbeat", json=hb, headers={"Authorization": "Bearer node-secret-for-tests-1234567890"})
    assert ok.status_code == 200
    s = a.get("/api/gpu/status").json()
    assert s["online"] is True and s["gpu"] == "RTX 5070 Ti"


def test_job_list_scoped_to_matter_membership(make_api):
    alice, bob = make_api("alice@example.com"), make_api("bob@example.com")
    m = new_matter(alice)
    alice.post("/api/inference", json={"matter_id": m["id"], "messages": [{"role": "user", "content": "hi"}]})
    assert len(alice.get(f"/api/jobs?matter_id={m['id']}").json()) == 1
    assert alice.get("/api/jobs").json()[0]["request"]["messages"][0]["content"] == "hi"
    assert bob.get(f"/api/jobs?matter_id={m['id']}").status_code == 404
    assert bob.get("/api/jobs").json() == []
