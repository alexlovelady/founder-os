import asyncio
import json
from datetime import date, datetime, timedelta, timezone

import httpx
import pytest

from legalai.config import get_settings
from legalai.corpus.adapters import EcfrAdapter, FetchResult, SourceError, UrlAdapter, validate_config
from legalai.corpus.refresh import enqueue_due_refreshes
from legalai.corpus.safe_fetch import Fetched, FetchBlocked, check_url, safe_get
from legalai.db import session_scope
from legalai.models import CorpusSource, Document, DocumentChunk, DocumentVersion, Job
from tests.test_research import GOOD, ScriptedLLM, finish, start  # noqa: F401
from tests.test_retrieval import emb, drain, mk_matter, upload  # noqa: F401

PUBLIC = lambda host: ["93.184.216.34"]
REG_V1 = "Section 1.1 Scope. A covered entity shall report a breach within sixty days of discovery.\n\nSection 1.2 Penalties. The penalty is five hundred dollars per violation."
REG_V2 = "Section 1.1 Scope. A covered entity shall report a breach within thirty days of discovery.\n\nSection 1.2 Penalties. The penalty is five hundred dollars per violation."


# ---- SSRF-safe fetch ------------------------------------------------------------------------------------------
def test_check_url_blocks_unsafe_targets():
    for bad in ("http://example.com/x", "https://127.0.0.1/x", "https://10.0.0.5/x", "https://169.254.169.254/latest/meta-data",
                "https://[::1]/x", "https://user:pw@example.com/x", "ftp://example.com", "https:///nohost"):
        with pytest.raises(FetchBlocked):
            check_url(bad, PUBLIC)
    with pytest.raises(FetchBlocked):
        check_url("https://evil.example.com/x", lambda h: ["192.168.1.10"])         # DNS points at a private address
    with pytest.raises(FetchBlocked):
        check_url("https://evil.example.com/x", lambda h: ["93.184.216.34", "10.0.0.1"])  # any private answer blocks
    check_url("https://www.ecfr.gov/x", PUBLIC)


def test_safe_get_blocks_redirect_to_private_and_oversize():
    def redirect(req):
        return httpx.Response(302, headers={"location": "https://10.1.1.1/secret"})
    with pytest.raises(FetchBlocked):
        asyncio.run(safe_get("https://example.com/a", resolver=PUBLIC, transport=httpx.MockTransport(redirect)))
    big = httpx.MockTransport(lambda r: httpx.Response(200, content=b"x" * 5000))
    with pytest.raises(FetchBlocked, match="too large"):
        asyncio.run(safe_get("https://example.com/a", resolver=PUBLIC, transport=big, max_bytes=1000))
    ok = httpx.MockTransport(lambda r: httpx.Response(200, content=b"hello", headers={"etag": "abc"}))
    r = asyncio.run(safe_get("https://example.com/a", resolver=PUBLIC, transport=ok))
    assert r.status == 200 and r.content == b"hello"
    loop = httpx.MockTransport(lambda r: httpx.Response(302, headers={"location": "https://example.com/b"}))
    with pytest.raises(FetchBlocked, match="redirects"):
        asyncio.run(safe_get("https://example.com/a", resolver=PUBLIC, transport=loop))


# ---- adapters -------------------------------------------------------------------------------------------------
ECFR_XML = b"""<?xml version="1.0"?><DIV5 N="45" TYPE="PART"><HEAD>PART 164 - SECURITY AND PRIVACY</HEAD>
<DIV8 N="164.404" TYPE="SECTION"><HEAD>164.404 Notification to individuals.</HEAD><P>(a) A covered entity shall, following the discovery of a breach of unsecured protected health information, notify each individual whose information has been affected. This paragraph is long enough to count as real regulatory text for the adapter test.</P>
<P>(b) Timeliness: without unreasonable delay and in no case later than 60 calendar days after discovery of a breach.</P></DIV8></DIV5>"""


def ecfr_fetch(calls):
    async def fetch(url, headers=None):
        calls.append(url)
        if url.endswith("titles.json"):
            return Fetched(200, {}, json.dumps({"titles": [{"number": 45, "up_to_date_as_of": "2025-02-01"}]}).encode(), url)
        return Fetched(200, {}, ECFR_XML, url)
    return fetch


def test_ecfr_adapter_extracts_sections_and_detects_unchanged():
    calls = []
    a = EcfrAdapter(fetch=ecfr_fetch(calls))
    r = asyncio.run(a.run({"title": 45, "part": 164}))
    text = r.content.decode()
    assert "164.404 Notification to individuals." in text and "60 calendar days" in text
    assert r.effective_from == date(2025, 2, 1) and r.citation == "45 C.F.R. pt. 164" and r.etag == "45:164:2025-02-01"
    assert r.source_url == "https://www.ecfr.gov/current/title-45/part-164" and r.filename.endswith(".txt")
    again = asyncio.run(a.run({"title": 45, "part": 164}, etag=r.etag))
    assert again.unchanged and len(calls) == 3                      # second run only asked for the title index


def test_ecfr_adapter_errors_are_clear():
    async def missing(url, headers=None):
        return Fetched(200, {}, json.dumps({"titles": []}).encode(), url) if url.endswith("titles.json") else Fetched(404, {}, b"", url)
    with pytest.raises(SourceError, match="not found"):
        asyncio.run(EcfrAdapter(fetch=missing).run({"title": 45, "part": 164}))


def test_url_adapter_conditional_get_and_content_types():
    async def fetch(url, headers=None):
        if headers and headers.get("If-None-Match") == "v1":
            return Fetched(304, {}, b"", url)
        return Fetched(200, {"content-type": "text/html; charset=utf-8", "etag": "v1"}, b"<h1>Rule</h1><p>Text</p>", url)
    a = UrlAdapter(fetch=fetch)
    r = asyncio.run(a.run({"url": "https://agency.gov/rule", "title": "Rule 5", "effective_date": "2024-05-01"}))
    assert r.filename == "source.html" and r.etag == "v1" and r.effective_from == date(2024, 5, 1) and r.title == "Rule 5"
    assert asyncio.run(a.run({"url": "https://agency.gov/rule"}, etag="v1")).unchanged
    async def exe(url, headers=None):
        return Fetched(200, {"content-type": "application/x-msdownload"}, b"MZ", url)
    with pytest.raises(SourceError, match="Unsupported"):
        asyncio.run(UrlAdapter(fetch=exe).run({"url": "https://agency.gov/x"}))


def test_validate_config():
    assert validate_config("ecfr", {"title": "45", "part": "164"}) == {"title": 45, "part": 164}
    for adapter, cfg in (("ecfr", {"title": 99, "part": 1}), ("ecfr", {}), ("url", {"url": "http://x.gov/a"}), ("nope", {})):
        with pytest.raises(SourceError):
            validate_config(adapter, cfg)


# ---- refresh flow ---------------------------------------------------------------------------------------------
class FakeAdapter:
    def __init__(self, content, eff, etag="e1"):
        self.content, self.eff, self.etag, self.runs = content, eff, etag, 0

    async def run(self, cfg, etag=None):
        self.runs += 1
        if etag and etag == self.etag:
            return FetchResult(unchanged=True, etag=etag)
        return FetchResult(content=self.content.encode(), filename="reg.txt", title="HIPAA Breach Rule", citation="45 C.F.R. pt. 164",
                           effective_from=self.eff, source_url="https://www.ecfr.gov/current/title-45/part-164", etag=self.etag,
                           retrieved_at=datetime.now(timezone.utc))


def add_source(a, monkeypatch, adapter):
    monkeypatch.setattr("legalai.corpus.refresh.build_adapter", lambda name: adapter)
    r = a.post("/api/library/sources", json={"name": "HIPAA", "adapter": "ecfr", "config": {"title": 45, "part": 164},
                                             "jurisdiction": "Federal", "authority_type": "regulation", "refresh_hours": 24})
    assert r.status_code == 201, r.text
    return r.json()


def lib_doc(a):
    docs = a.get("/api/library").json()["documents"]
    return docs[0] if docs else None


def test_library_refresh_versions_history_and_dated_search(make_api, emb, monkeypatch):
    a = make_api("admin@example.com")
    ad = FakeAdapter(REG_V1, date(2024, 1, 1))
    src = add_source(a, monkeypatch, ad)
    drain()
    d = lib_doc(a)
    assert d["versions"] == 1 and d["current_version"] == 1 and d["parse_status"] == "parsed" and d["official_source"] is True
    assert d["effective_from"] == "2024-01-01" and d["retrieved_at"] and d["authority_type"] == "regulation"
    # embedded under BOTH models so private matters (local vectors) and standard matters can search it
    with session_scope() as db:
        from legalai.models import ChunkEmbedding
        assert {e.model for e in db.query(ChunkEmbedding)} == {"voyage:voyage-law-2", "local:qwen3-embedding:0.6b"}
    # unchanged source: no new version
    a.post(f"/api/library/sources/{src['id']}/refresh")
    drain()
    assert lib_doc(a)["versions"] == 1
    assert [s for s in a.get("/api/library/sources").json()][0]["last_status"] == "unchanged"
    # changed source: new version, history kept, prior range closed
    ad.content, ad.eff, ad.etag = REG_V2, date(2025, 1, 1), "e2"
    a.post(f"/api/library/sources/{src['id']}/refresh")
    drain()
    d = lib_doc(a)
    assert d["versions"] == 2 and d["current_version"] == 2
    vs = a.get(f"/api/documents/{d['id']}/versions").json()
    assert [v["version_number"] for v in vs] == [1, 2]
    with session_scope() as db:
        v1 = db.query(DocumentVersion).filter_by(version_number=1).one()
        assert v1.effective_to == date(2024, 12, 31) and v1.effective_from == date(2024, 1, 1)
    m = mk_matter(a, "standard")
    now = a.post(f"/api/matters/{m['id']}/search", json={"query": "report a breach within days of discovery"}).json()["hits"]
    assert now and "thirty days" in now[0]["text"] and now[0]["version_number"] == 2
    # a research question tied to an earlier date gets the text that was in force then
    past = finish(a, start(a, m["id"], "When must a breach be reported?", as_of="2024-06-01"), ScriptedLLM([GOOD]))
    assert "sixty days" in past["result"]["evidence"][0]["text"] and past["result"]["evidence"][0]["version_number"] == 1
    before = finish(a, start(a, m["id"], "When must a breach be reported?", as_of="2020-01-01"), ScriptedLLM([GOOD]))
    assert "No relevant passages" in before["answer"]                                   # nothing was in force yet


def test_library_is_shared_read_only_and_not_in_matter_lists(make_api, emb, monkeypatch):
    admin = make_api("admin@example.com")
    add_source(admin, monkeypatch, FakeAdapter(REG_V1, date(2024, 1, 1)))
    drain()
    bob = make_api("bob@example.com")
    m = mk_matter(bob, "local_only")
    assert bob.get(f"/api/matters/{m['id']}/documents").json() == []                      # library not mixed into the matter
    hits = bob.post(f"/api/matters/{m['id']}/search", json={"query": "penalty per violation"}).json()
    assert hits["hits"] and hits["hits"][0]["document_title"] == "HIPAA Breach Rule" and hits["embedding_model"].startswith("local:")
    assert hits["mode"] == "hybrid"                                                       # local vectors exist for library text
    assert bob.get(f"/api/chunks/{hits['hits'][0]['chunk_id']}").status_code == 200       # anyone can open a public citation
    d = lib_doc(bob)
    assert d and bob.get("/api/library/sources").status_code == 403
    assert bob.post("/api/library/sources", json={"name": "x", "adapter": "ecfr", "config": {"title": 1, "part": 1}}).status_code == 403
    assert bob.patch(f"/api/documents/{d['id']}/authority", json={"superseded": True}).status_code == 403
    assert bob.post(f"/api/documents/{d['id']}/reindex").status_code == 403
    assert bob.put(f"/api/library/documents/{d['id']}/treatment", json={"treatment": []}).status_code == 403
    assert bob.get(f"/api/matters/{d['library_matter_id']}").status_code == 404           # not a normal matter
    assert bob.get("/api/matters").json()[0]["id"] == m["id"] and len(bob.get("/api/matters").json()) == 1


def test_source_creation_validates_config(make_api, emb):
    a = make_api("admin@example.com")
    assert a.post("/api/library/sources", json={"name": "x", "adapter": "url", "config": {"url": "http://insecure.gov/a"}}).status_code == 422
    assert a.post("/api/library/sources", json={"name": "x", "adapter": "ecfr", "config": {"title": 99, "part": 1}}).status_code == 422


def test_treatment_lowers_rank_flags_and_prompt_labels(make_api, emb, monkeypatch):
    a = make_api("admin@example.com")
    add_source(a, monkeypatch, FakeAdapter(REG_V1, date(2024, 1, 1)))
    drain()
    d = lib_doc(a)
    r = a.put(f"/api/library/documents/{d['id']}/treatment", json={"treatment": [
        {"type": "superseded_by", "citing": "88 Fed. Reg. 1", "note": "Replaced by the 2025 rule", "date": "2025-03-01", "source": "Federal Register"}]})
    assert r.status_code == 200 and r.json()["treatment"][0]["date"] == "2025-03-01"
    assert a.put(f"/api/library/documents/{d['id']}/treatment", json={"treatment": [{"type": "good_law"}]}).status_code == 422
    m = mk_matter(a, "standard")
    llm = ScriptedLLM([GOOD])
    run = finish(a, start(a, m["id"], "When must a breach be reported?"), llm)
    ev = run["result"]["evidence"][0]
    assert "negative_treatment" in ev["flags"]
    assert "NEGATIVE TREATMENT" in next(ms for k, ms in llm.calls if k == "answer")[1]["content"]
    assert "Superseded or out-of-date sources retrieved" in [c["label"] for c in run["result"]["coverage"]]
    strict = finish(a, start(a, m["id"], "When must a breach be reported?", require_current=True), ScriptedLLM([GOOD]))
    assert "No relevant passages" in strict["answer"]


def test_currentness_and_treatment_labels_for_external_authority(make_api, emb, monkeypatch):
    a = make_api("admin@example.com")
    add_source(a, monkeypatch, FakeAdapter(REG_V1, date(2024, 1, 1)))
    drain()
    with session_scope() as db:
        v = db.query(DocumentVersion).first()
        v.source_retrieved_at = datetime.now(timezone.utc) - timedelta(days=90)
        doc = db.get(Document, v.document_id)
        doc.authority_type, doc.court_level = "court_opinion", "appellate"
    m = mk_matter(a, "standard")
    run = finish(a, start(a, m["id"], "When must a breach be reported?"), ScriptedLLM([GOOD]))
    labels = [c["label"] for c in run["result"]["coverage"]]
    assert "Currentness not verified as of the requested date" in labels and "No treatment data" in labels


def test_scheduler_enqueues_due_sources_once(make_api, emb, monkeypatch):
    a = make_api("admin@example.com")
    add_source(a, monkeypatch, FakeAdapter(REG_V1, date(2024, 1, 1)))
    drain()
    s = get_settings()
    assert enqueue_due_refreshes(s) == 0                                                  # checked moments ago
    with session_scope() as db:
        src = db.query(CorpusSource).one()
        src.last_checked_at = datetime.now(timezone.utc) - timedelta(hours=25)
    assert enqueue_due_refreshes(s) == 1 and enqueue_due_refreshes(s) == 0                # one pending refresh per source
    with session_scope() as db:
        db.query(CorpusSource).one().enabled = False
        for j in db.query(Job).filter(Job.job_type == "corpus_refresh", Job.state == "QUEUED"):
            j.state = "CANCELED"
        db.query(CorpusSource).one().last_checked_at = None
    assert enqueue_due_refreshes(s) == 0                                                  # disabled sources are skipped


def test_failed_source_records_error_and_retries(make_api, emb, monkeypatch):
    a = make_api("admin@example.com")

    class Broken:
        async def run(self, cfg, etag=None):
            raise SourceError("Source returned HTTP 503")
    add_source(a, monkeypatch, Broken())
    drain()
    src = a.get("/api/library/sources").json()[0]
    assert "HTTP 503" in src["last_status"] and lib_doc(a) is None
