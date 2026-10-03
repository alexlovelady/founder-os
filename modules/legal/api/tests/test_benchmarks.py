"""Benchmark suite (spec section 30).

Embedder modes (BENCH_EMBEDDER):
  fake    (default) deterministic bag-of-words stand-in; measures the lexical path, fusion and scoping. Regression gate only.
  local   the real private-GPU embedding model through the gateway; needs BENCH_GPU_URL and BENCH_GPU_TOKEN.
  voyage  the real Voyage model; needs EMBEDDING_API_KEY in the environment (text from the benchmark contracts is sent to Voyage).

Metrics are written to benchmarks/results/latest.json. benchmarks/baseline.json keeps one reference per embedder: a metric
that drops more than TOLERANCE below its baseline fails, so prompt, retrieval or model changes cannot silently regress.
Refresh a baseline deliberately with BENCH_UPDATE_BASELINE=1."""
import json
import os
import random
import re
from datetime import datetime, timezone
from pathlib import Path

import pytest

from legalai.citations.validate import EvidenceItem, validate_answer
from legalai.config import get_settings
from legalai.ingestion.chunking import chunk_document
from legalai.ingestion.parsers import parse_document
from tests.test_retrieval import FakeEmbedder, drain, mk_matter, upload, emb  # noqa: F401

ROOT = Path(__file__).resolve().parents[2] / "benchmarks"
MODE = os.environ.get("BENCH_EMBEDDER", "fake")
TOLERANCE = 0.03
THRESHOLDS = {"retrieval_recall_at_5": 0.85, "retrieval_mrr": 0.60, "citation_fabrication_rejected": 1.0,
              "quote_mutation_detected": 1.0, "valid_quote_accepted": 0.98, "wrong_source_flagged": 0.85,
              "uncited_claim_flagged": 1.0}
RESULTS: dict[str, float] = {}
LIVE_RECALL, LIVE_MRR = 0.90, 0.80  # real embedders (measured: local 0.95 / 0.87, voyage 0.97 / 0.92)


def _contracts():
    return {p.name: p.read_bytes() for p in sorted((ROOT / "data" / "contracts").glob("*.txt"))}


def _cases():
    out = []
    for f in sorted((ROOT / "data").glob("retrieval_cases*.json")):
        out += json.loads(f.read_text(encoding="utf8"))
    return out


def _record(name: str, value: float):
    RESULTS[name] = round(value, 4)


@pytest.fixture(scope="module", autouse=True)
def _write_report():
    yield
    if not RESULTS:
        return
    report = {"run_at": datetime.now(timezone.utc).isoformat(), "embedder": MODE, "metrics": RESULTS, "thresholds": THRESHOLDS}
    (ROOT / "results").mkdir(exist_ok=True)
    (ROOT / "results" / f"latest-{MODE}.json").write_text(json.dumps(report, indent=2))
    if MODE == "fake":
        (ROOT / "results" / "latest.json").write_text(json.dumps(report, indent=2))
    base = ROOT / "baseline.json"
    allb = json.loads(base.read_text()) if base.exists() else {}
    if "metrics" in allb:  # migrate the old single-embedder layout
        allb = {allb.get("embedder", "fake"): allb["metrics"]}
    if os.environ.get("BENCH_UPDATE_BASELINE") or MODE not in allb:
        allb[MODE] = {**allb.get(MODE, {}), **RESULTS}
        base.write_text(json.dumps(allb, indent=2))


def _baseline_check(name: str, value: float):
    base = ROOT / "baseline.json"
    if not base.exists():
        return
    allb = json.loads(base.read_text())
    ref = (allb if "metrics" not in allb else {allb.get("embedder", "fake"): allb["metrics"]}).get(MODE, {})
    if name in ref:
        assert value >= ref[name] - TOLERANCE, f"{name} regressed: {value} vs baseline {ref[name]} ({MODE})"


@pytest.fixture
def embed_env(request, monkeypatch):
    """Returns the privacy mode to use for the benchmark matter and wires the chosen embedder."""
    if MODE == "fake":
        request.getfixturevalue("emb")
        st = get_settings()
        st.w_semantic = st.w_semantic_exact = 1.0   # production weights are tuned for real embedders; the stand-in has no semantics
        return "standard"
    if MODE == "local":
        url, tok = os.environ.get("BENCH_GPU_URL"), os.environ.get("BENCH_GPU_TOKEN")
        if not url or not tok:
            pytest.skip("set BENCH_GPU_URL and BENCH_GPU_TOKEN for BENCH_EMBEDDER=local")
        for k, v in {"GPU_MODE": "push", "GPU_NODE_URL": url, "GPU_NODE_TOKEN": tok, "EMBEDDING_API_KEY": ""}.items():
            monkeypatch.setenv(k, v)
        get_settings.cache_clear()
        return "private"           # private matters embed on the GPU
    if MODE == "voyage":
        if not os.environ.get("EMBEDDING_API_KEY"):
            pytest.skip("set EMBEDDING_API_KEY for BENCH_EMBEDDER=voyage")
        monkeypatch.setenv("EMBEDDING_PROVIDER", "external")
        get_settings.cache_clear()
        return "standard"
    raise AssertionError(f"unknown BENCH_EMBEDDER {MODE}")


def test_retrieval_recall_and_mrr(make_api, embed_env):
    a = make_api("admin@example.com")
    m = mk_matter(a, embed_env)
    for name, data in _contracts().items():
        upload(a, m["id"], name, data)
    drain()
    cases = _cases()
    assert len(cases) >= 100 and len(_contracts()) >= 7
    ranks = {"hybrid": [], "lexical": [], "semantic": []}
    hard_ranks = {"hybrid": [], "lexical": [], "semantic": []}
    misses = []
    for c in cases:
        for mode in ranks:
            hits = a.post(f"/api/matters/{m['id']}/search", json={"query": c["q"], "k": 10, "mode": mode}).json()["hits"]
            r = next((i for i, h in enumerate(hits, 1) if h["document_title"] == c["doc"] and c["contains"] in h["text"]), None)
            ranks[mode].append(r)
            if c.get("hard"):
                hard_ranks[mode].append(r)
            if mode == "hybrid" and (r is None or r > 5):
                misses.append((c["q"], r))
    rec = lambda rs, k: sum(1 for r in rs if r is not None and r <= k) / max(1, len(rs))
    mrr = lambda rs: sum(1 / r for r in rs if r) / max(1, len(rs))
    for mode, rs in ranks.items():
        _record(f"retrieval_{mode}_recall_at_1", rec(rs, 1))
        _record(f"retrieval_{mode}_recall_at_5", rec(rs, 5))
        _record(f"retrieval_{mode}_hard_recall_at_5", rec(hard_ranks[mode], 5))
    _record("retrieval_recall_at_5", rec(ranks["hybrid"], 5))
    _record("retrieval_mrr", mrr(ranks["hybrid"]))
    _record("retrieval_cases", float(len(cases)))
    _record("retrieval_hard_cases", float(len(hard_ranks["hybrid"])))
    easy = [r for r, c in zip(ranks["hybrid"], cases) if not c.get("hard")]
    _record("retrieval_easy_recall_at_5", rec(easy, 5))
    # The stand-in embedder has no semantics, so it is gated on the questions that share words with the text; real
    # embedders are gated on everything, including the paraphrased "hard" questions.
    if MODE == "fake":
        assert RESULTS["retrieval_easy_recall_at_5"] >= 0.95, f"misses: {misses}"
    else:
        assert RESULTS["retrieval_recall_at_5"] >= LIVE_RECALL, f"misses: {misses}"
        assert RESULTS["retrieval_mrr"] >= LIVE_MRR
    assert RESULTS["retrieval_hybrid_recall_at_5"] >= max(RESULTS["retrieval_lexical_recall_at_5"], RESULTS["retrieval_semantic_recall_at_5"]) - 0.05
    for k in ("retrieval_easy_recall_at_5", "retrieval_recall_at_5", "retrieval_mrr", "retrieval_hybrid_hard_recall_at_5"):
        _baseline_check(k, RESULTS[k])


# ---- validator adversarial benchmark ------------------------------------------------------------------------------
def _evidence():
    ev, docs = [], {}
    for name, data in _contracts().items():
        parsed = parse_document(name, data)
        docs[name] = parsed.text
        for c in chunk_document(parsed):
            if len(c.text) > 60:
                ev.append((name, c))
    items = [EvidenceItem(f"CITE-{i:03d}", f"c{i}", c.text, name, name, 1, None, c.start) for i, (name, c) in enumerate(ev, 1)]
    return ev, items, docs


def _first_sentence(text: str) -> str:
    t = re.sub(r"^(?:\d+(?:\.\d+)*\.?|ARTICLE \d+ [A-Z ]+)\s+", "", text.strip())
    s = re.split(r"(?<=[.!?])\s", t)[0].strip()
    return s if len(s) >= 25 else t[:120]


def test_citation_and_quote_validation_adversarial_set():
    ev, items, docs = _evidence()
    assert len(items) >= 30
    rng = random.Random(1234)
    total = {k: 0 for k in ("valid", "fab", "mut", "wrong", "uncited")}
    ok = dict(total)
    for i, ((name, chunk), item) in enumerate(zip(ev, items)):
        sent = _first_sentence(chunk.text).rstrip(".")
        if len(sent.split()) < 5:
            continue
        # 1. a correct, verbatim, correctly cited statement must pass
        r = validate_answer(f'## Analysis\nThe agreement states "{sent}" [{item.cite_id}].', items)
        total["valid"] += 1
        q = r.quotes[0] if r.quotes else None
        good = (not r.fabricated and q and q["status"] == "verified" and q["cite_id"] == item.cite_id
                and docs[name][q["doc_start"]:q["doc_end"]] == q["quote"])
        ok["valid"] += bool(good)
        # 2. fabricated citation IDs are always removed and reported
        r = validate_answer(f"## Analysis\nThe agreement states that {sent.lower()} [CITE-9{i:02d}].", items)
        total["fab"] += 1
        ok["fab"] += bool(r.fabricated and f"CITE-9{i:02d}" not in r.cleaned)
        # 3. a quote altered by one word or one number never verifies
        words = sent.split()
        j = rng.randrange(len(words))
        mutated = " ".join(words[:j] + ["banana"] + words[j + 1:]) if not re.search(r"\d", sent) else re.sub(r"\d", lambda m: str((int(m.group(0)) + 1) % 10), sent, count=1)
        if len(mutated) >= 12 and mutated != sent:
            r = validate_answer(f'## Analysis\nThe agreement states "{mutated}" [{item.cite_id}].', items)
            total["mut"] += 1
            ok["mut"] += bool(r.quotes and r.quotes[0]["status"] == "mismatch")
        # 4. a claim cited to a passage from a different contract is flagged as unsupported
        other = items[(i + 17) % len(items)]
        if ev[(i + 17) % len(ev)][0] != name:
            claim = " ".join(sent.split()[:18])
            r = validate_answer(f"## Analysis\n{claim} and nothing else matters here [{other.cite_id}].", items)
            total["wrong"] += 1
            ok["wrong"] += bool(r.segments[-1].status in ("unsupported", "partial") and r.segments[-1].status != "supported")
        # 5. substantive statements without any citation are flagged
        r = validate_answer(f"## Analysis\n{' '.join(sent.split()[:14])} and the parties agreed to this.", items)
        total["uncited"] += 1
        ok["uncited"] += bool(r.segments[-1].status == "uncited")
    assert min(total.values()) >= 20, total
    _record("valid_quote_accepted", ok["valid"] / total["valid"])
    _record("citation_fabrication_rejected", ok["fab"] / total["fab"])
    _record("quote_mutation_detected", ok["mut"] / total["mut"])
    _record("wrong_source_flagged", ok["wrong"] / total["wrong"])
    _record("uncited_claim_flagged", ok["uncited"] / total["uncited"])
    _record("adversarial_cases", float(sum(total.values())))
    for k in ("valid_quote_accepted", "citation_fabrication_rejected", "quote_mutation_detected", "wrong_source_flagged", "uncited_claim_flagged"):
        assert RESULTS[k] >= THRESHOLDS[k], (k, RESULTS[k], total)
        _baseline_check(k, RESULTS[k])
    assert RESULTS["adversarial_cases"] >= 100


# ---- fusion weight sweep (live embedders only; a tuning tool, not a gate) -------------------------------------------
SWEEP = [(1.0, 1.0), (2.0, 1.0), (3.0, 1.0), (4.0, 1.0), (6.0, 1.0), (10.0, 1.0)]


def test_fusion_weight_sweep(make_api, embed_env, monkeypatch):
    if MODE == "fake":
        pytest.skip("the sweep is only meaningful with a real embedding model")
    import legalai.retrieval.hybrid as H
    real_build = H.build_embedding_provider
    cache: dict[str, list[float]] = {}

    class Cached:
        def __init__(self, inner):
            self.inner, self.external, self.name = inner, inner.external, inner.name
            self.tokens_used = 0

        async def embed_query(self, q):
            if q not in cache:
                cache[q] = await self.inner.embed_query(q)
            return cache[q]
    monkeypatch.setattr(H, "build_embedding_provider", lambda s, external: Cached(real_build(s, external)))
    a = make_api("admin@example.com")
    m = mk_matter(a, embed_env)
    for name, data in _contracts().items():
        upload(a, m["id"], name, data)
    drain()
    cases = _cases()
    s = get_settings()
    out = {}
    for ws, wl in SWEEP:
        s.w_semantic, s.w_lexical = ws, wl
        ranks, hard = [], []
        for c in cases:
            hits = a.post(f"/api/matters/{m['id']}/search", json={"query": c["q"], "k": 10, "mode": "hybrid"}).json()["hits"]
            r = next((i for i, h in enumerate(hits, 1) if h["document_title"] == c["doc"] and c["contains"] in h["text"]), None)
            ranks.append(r)
            if c.get("hard"):
                hard.append(r)
        rec = lambda rs, k: sum(1 for r in rs if r is not None and r <= k) / len(rs)
        out[f"{ws}/{wl}"] = {"recall@1": round(rec(ranks, 1), 3), "recall@5": round(rec(ranks, 5), 3), "hard_recall@5": round(rec(hard, 5), 3),
                             "mrr": round(sum(1 / r for r in ranks if r) / len(ranks), 3)}
    (ROOT / "results" / f"fusion-sweep-{MODE}.json").write_text(json.dumps(out, indent=2))
    print(json.dumps(out, indent=1))
