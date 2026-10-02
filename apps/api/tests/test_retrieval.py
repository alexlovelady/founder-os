import asyncio
import hashlib
import json
import re
import uuid

import httpx
import pytest

from legalai.config import get_settings
from legalai.db import session_scope
from legalai.jobs.runner import process_one
from legalai.models import ChunkEmbedding, DocumentChunk, Job, Matter, ProviderUsage
from legalai.providers.base import EmbeddingProvider, ProviderError, ProviderUnavailable
from legalai.providers.embeddings import LocalEmbeddingProvider, VoyageEmbeddingProvider
from tests.test_jobs import FakeProvider
from tests.test_ingestion import CONTRACT

DIM = 1024


def vec(text: str) -> list[float]:
    """Deterministic bag-of-words embedding: texts sharing words are close in cosine space."""
    v = [0.0] * DIM
    for w in re.findall(r"[a-z]{3,}", text.lower()):
        v[int(hashlib.md5(w.encode()).hexdigest(), 16) % DIM] += 1.0
    n = sum(x * x for x in v) ** 0.5 or 1.0
    return [x / n for x in v]


class FakeEmbedder(EmbeddingProvider):
    def __init__(self, external: bool, up: bool = True):
        self.external, self.name, self.up = external, "voyage" if external else "local_gpu", up
        self.doc_calls, self.query_calls, self.tokens_used = 0, 0, 0

    async def embed_documents(self, texts):
        if not self.up:
            raise ProviderUnavailable("gpu down")
        self.doc_calls += len(texts)
        self.tokens_used += 10 * len(texts)
        return [vec(t) for t in texts]

    async def embed_query(self, text):
        if not self.up:
            raise ProviderUnavailable("gpu down")
        self.query_calls += 1
        return vec(text)


@pytest.fixture
def emb(monkeypatch):
    """Patch embedding factories; records every (external?) request so privacy can be asserted."""
    st = {"requested": [], "up": True, "providers": []}

    def factory(settings, external):
        st["requested"].append(external)
        p = FakeEmbedder(external, st["up"])
        st["providers"].append(p)
        return p
    monkeypatch.setattr("legalai.ingestion.pipeline.build_embedding_provider", factory)
    monkeypatch.setattr("legalai.retrieval.hybrid.build_embedding_provider", factory)
    monkeypatch.setenv("EMBEDDING_API_KEY", "test-key")
    monkeypatch.setenv("EMBEDDING_PROVIDER", "external")
    get_settings.cache_clear()
    return st


def drain(primary=None, rounds=30):
    primary = primary or FakeProvider("local_gpu")
    for _ in range(rounds):
        if not asyncio.run(process_one(get_settings(), primary=primary)):
            return


def mk_matter(a, mode="standard", **kw):
    r = a.post("/api/matters", json={"name": "m", "privacy_mode": mode, **kw})
    assert r.status_code == 201, r.text
    return r.json()


def upload(a, mid, name, data, **form):
    r = a.post("/api/documents", data={"matter_id": mid, **form}, files={"file": (name, data)})
    assert r.status_code == 201, r.text
    return r.json()


def search(a, mid, q, **kw):
    r = a.post(f"/api/matters/{mid}/search", json={"query": q, **kw})
    assert r.status_code == 200, r.text
    return r.json()


def test_end_to_end_ingest_embed_search_and_citation_anchor(make_api, emb):
    a = make_api("admin@example.com")
    m = mk_matter(a, "standard")
    assert m["embedding_route"] == "external" and m["embedding_model"].startswith("voyage:")
    d = upload(a, m["id"], "msa.txt", CONTRACT.encode())
    drain()
    v = a.get(f"/api/documents/{d['id']}/versions").json()[0]
    assert (v["parse_status"], v["embed_status"], v["embedding_model"]) == ("parsed", "embedded", m["embedding_model"])
    r = search(a, m["id"], "Can either party terminate for convenience on notice?")
    top = r["hits"][0]
    assert top["cite_id"] == "CITE-001" and "terminate for convenience" in top["text"]
    assert top["lexical_rank"] and top["semantic_rank"]                 # both retrievers contributed
    assert top["heading_path"][0].startswith("ARTICLE II") and top["document_title"] == "msa.txt"
    # citation anchor opens the exact source location
    c = a.get(f"/api/chunks/{top['chunk_id']}").json()
    full = CONTRACT.replace("\n\n", "\n\n")
    assert c["text"] == top["text"] and (c["before"] + c["text"] + c["after"]) in _norm(full)
    assert r["mode"] == "hybrid" and r["warnings"] == []


def _norm(t):
    return "\n\n".join(re.sub(r"\s+", " ", p).strip() for p in re.split(r"\n\s*\n", t) if p.strip())


def test_search_modes_and_exact_term(make_api, emb):
    a = make_api("admin@example.com")
    m = mk_matter(a, "standard")
    upload(a, m["id"], "msa.txt", CONTRACT.encode())
    drain()
    lex = search(a, m["id"], "indemnify gross negligence", mode="lexical")
    assert lex["hits"][0]["semantic_rank"] is None and "indemnify" in lex["hits"][0]["text"]
    sem = search(a, m["id"], "indemnify gross negligence", mode="semantic")
    assert sem["hits"][0]["lexical_rank"] is None and "indemnify" in sem["hits"][0]["text"]
    assert search(a, m["id"], "zzzzqqq nothing matches", mode="lexical")["hits"] == []


def test_matter_isolation_in_search(make_api, emb):
    alice, bob = make_api("alice@example.com"), make_api("bob@example.com")
    ma, mb = mk_matter(alice), mk_matter(bob)
    upload(alice, ma["id"], "secret.txt", b"The confidential acquisition price is forty million dollars.")
    upload(bob, mb["id"], "other.txt", b"Employee handbook about vacation policy.")
    drain()
    for mode in ("lexical", "semantic", "hybrid"):
        hits = search(bob, mb["id"], "acquisition price million dollars", mode=mode)["hits"]
        assert all("acquisition" not in h["text"] for h in hits)
    assert bob.post(f"/api/matters/{ma['id']}/search", json={"query": "price"}).status_code == 404
    cid = search(alice, ma["id"], "acquisition price")["hits"][0]["chunk_id"]
    assert bob.get(f"/api/chunks/{cid}").status_code == 404


def test_only_current_version_is_searchable(make_api, emb):
    a = make_api("admin@example.com")
    m = mk_matter(a)
    d = upload(a, m["id"], "t.txt", b"Payment is due within thirty days.")
    drain()
    upload(a, m["id"], "t.txt", b"Payment is due within sixty days.", document_id=d["id"])
    drain()
    hits = search(a, m["id"], "payment due days")["hits"]
    assert len(hits) == 1 and "sixty" in hits[0]["text"] and hits[0]["version_number"] == 2


def test_privacy_routes_never_use_external_for_local_only_or_private(make_api, emb):
    a = make_api("admin@example.com")
    lo = mk_matter(a, "local_only")
    pv = mk_matter(a, "private")
    assert lo["embedding_route"] == pv["embedding_route"] == "local"
    for m in (lo, pv):
        upload(a, m["id"], "x.txt", b"Some private text about indemnification.")
    drain()
    search(a, lo["id"], "indemnification")
    search(a, pv["id"], "indemnification")
    assert emb["requested"] and set(emb["requested"]) == {False}        # external provider never even constructed
    with session_scope() as db:
        assert db.query(ProviderUsage).filter_by(external=True).count() == 0
        assert {e.model for e in db.query(ChunkEmbedding)} == {"local:qwen3-embedding:0.6b"}
    # explicit opt-in on a private matter switches the route
    r = a.patch(f"/api/matters/{pv['id']}", json={"external_embedding_enabled": True}).json()
    assert r["embedding_route"] == "external"


def test_gpu_offline_embedding_waits_and_search_degrades_without_external(make_api, emb):
    a = make_api("admin@example.com")
    m = mk_matter(a, "private")
    upload(a, m["id"], "x.txt", b"The tenant shall pay rent monthly.")
    drain(FakeProvider("local_gpu"))                       # ingest ok, then embed runs and succeeds
    # now take the node offline and add another document
    d2 = upload(a, m["id"], "y.txt", b"The landlord shall maintain the premises.")
    drain(FakeProvider("local_gpu", online=False))
    jobs = a.get("/api/jobs?matter_id=" + m["id"]).json()
    waiting = [j for j in jobs if j["job_type"] == "embed_document" and j["state"] == "WAITING_FOR_GPU"]
    assert waiting and "Waiting for private GPU node" in waiting[0]["status_message"]
    emb["up"] = False
    r = search(a, m["id"], "landlord premises maintain")
    assert r["mode"] == "lexical" and any("unavailable" in w.lower() for w in r["warnings"])
    assert r["hits"] and "landlord" in r["hits"][0]["text"]
    assert set(emb["requested"]) == {False}


def test_embedding_cache_reuses_identical_inputs(make_api, emb):
    a = make_api("admin@example.com")
    m = mk_matter(a)
    upload(a, m["id"], "a.txt", b"Identical clause about governing law in Delaware.")
    drain()
    first = sum(p.doc_calls for p in emb["providers"])
    upload(a, m["id"], "b.txt", b"Identical clause about governing law in Delaware.")
    drain()
    assert sum(p.doc_calls for p in emb["providers"]) == first          # second upload embedded nothing new
    with session_scope() as db:
        job = db.query(Job).filter_by(job_type="embed_document").order_by(Job.created_at.desc()).first()
        assert job.result["embedded"] == 0 and job.result["reused_from_cache"] == 1


def test_external_embedding_budget_is_enforced_and_costs_recorded(make_api, emb, monkeypatch):
    a = make_api("admin@example.com")
    m = mk_matter(a)
    upload(a, m["id"], "a.txt", b"Clause one about termination.")
    drain()
    with session_scope() as db:
        u = db.query(ProviderUsage).filter_by(kind="embedding", external=True).one()
        assert u.cost_usd > 0
    monkeypatch.setenv("EMBEDDING_MONTHLY_BUDGET_USD", "0")
    get_settings.cache_clear()
    upload(a, m["id"], "b.txt", b"Different clause about assignment.")
    drain()
    failed = [j for j in a.get("/api/jobs?matter_id=" + m["id"]).json() if j["state"] == "FAILED"]
    assert failed and "budget" in failed[0]["error"].lower() and failed[0]["attempts"] == 1


def test_switching_to_local_only_reembeds_locally(make_api, emb):
    a = make_api("admin@example.com")
    m = mk_matter(a, "standard", external_embedding_enabled=True)
    d = upload(a, m["id"], "a.txt", b"Governing law clause for Delaware.")
    drain()
    assert a.get(f"/api/documents/{d['id']}/versions").json()[0]["embedding_model"].startswith("voyage:")
    r = a.patch(f"/api/matters/{m['id']}", json={"privacy_mode": "local_only"}).json()
    assert r["embedding_route"] == "local"
    drain()
    v = a.get(f"/api/documents/{d['id']}/versions").json()[0]
    assert v["embedding_model"].startswith("local:")
    hits = search(a, m["id"], "governing law Delaware")
    assert hits["embedding_model"].startswith("local:") and hits["hits"] and hits["mode"] == "hybrid"


def test_unparseable_and_scanned_documents_are_flagged_not_crashed(make_api, emb):
    a = make_api("admin@example.com")
    m = mk_matter(a)
    d = upload(a, m["id"], "bad.pdf", b"%PDF-1.4 garbage")
    drain()
    v = a.get(f"/api/documents/{d['id']}/versions").json()[0]
    assert v["parse_status"] == "failed" and v["status"] == "verified"
    assert search(a, m["id"], "anything")["hits"] == []


def test_reindex_endpoint_rebuilds_chunks(make_api, emb):
    a = make_api("admin@example.com")
    m = mk_matter(a)
    d = upload(a, m["id"], "a.txt", CONTRACT.encode())
    drain()
    with session_scope() as db:
        before = db.query(DocumentChunk).count()
    assert a.post(f"/api/documents/{d['id']}/reindex").status_code == 202
    drain()
    with session_scope() as db:
        assert db.query(DocumentChunk).count() == before


# ---- provider clients ------------------------------------------------------------------------------------
def test_voyage_client_input_types_retry_and_errors():
    calls = []

    def handler(req: httpx.Request):
        body = json.loads(req.content)
        calls.append((body["input_type"], len(body["input"]), req.headers["authorization"]))
        if len(calls) == 1:
            return httpx.Response(429)
        return httpx.Response(200, json={"data": [{"index": i, "embedding": [0.0] * DIM} for i in range(len(body["input"]))],
                                         "usage": {"total_tokens": 7}})

    async def go():
        p = VoyageEmbeddingProvider("k", "voyage-law-2", batch_size=2, transport=httpx.MockTransport(handler))
        import legalai.providers.embeddings as e
        orig, e.asyncio.sleep = e.asyncio.sleep, (lambda s: orig(0))
        try:
            docs = await p.embed_documents(["a", "b", "c"])
            q = await p.embed_query("q")
        finally:
            e.asyncio.sleep = orig
        return docs, q, p

    docs, q, p = asyncio.run(go())
    assert len(docs) == 3 and len(q) == DIM and p.tokens_used == 7 * 3
    assert calls[0][0] == "document" and calls[-1][0] == "query" and calls[0][2] == "Bearer k"
    assert [c[1] for c in calls[:3]] == [2, 2, 1]                       # 429 retried, then batches of 2


def test_voyage_bad_key_and_wrong_dimension():
    async def go(status, dim=DIM):
        t = httpx.MockTransport(lambda r: httpx.Response(status, json={"data": [{"index": 0, "embedding": [0.0] * dim}]}))
        await VoyageEmbeddingProvider("k", "m", transport=t, max_retries=0).embed_query("x")
    with pytest.raises(ProviderError, match="API key"):
        asyncio.run(go(401))
    with pytest.raises(ProviderError, match="dimension"):
        asyncio.run(go(200, dim=512))


def test_local_embedding_provider_signs_requests_and_maps_outages():
    seen = {}

    def ok(req: httpx.Request):
        seen.update(req.headers)
        return httpx.Response(200, json={"data": [{"index": 0, "embedding": [0.0] * DIM}]})

    p = LocalEmbeddingProvider("http://gpu", "tok" * 10, "m", transport=httpx.MockTransport(ok))
    asyncio.run(p.embed_query("x"))
    assert seen["authorization"].startswith("Bearer ") and seen["x-signature"] and seen["x-timestamp"]
    down = LocalEmbeddingProvider("http://gpu", "t", "m", transport=httpx.MockTransport(lambda r: httpx.Response(503)))
    with pytest.raises(ProviderUnavailable):
        asyncio.run(down.embed_query("x"))
