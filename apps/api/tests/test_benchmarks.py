"""Benchmark suite (spec section 30). Deterministic by default (fake embedder); set BENCH_EMBEDDER=local to run
retrieval against the real private-GPU embedding model instead (then the thresholds apply to that model).

Metrics are written to benchmarks/results/latest.json and compared with benchmarks/baseline.json: a metric that
drops more than TOLERANCE below the baseline fails the test, so prompt/retrieval/model changes cannot silently
regress. Refresh the baseline deliberately with BENCH_UPDATE_BASELINE=1."""
import json
import os
import random
import re
from datetime import datetime, timezone
from pathlib import Path

import pytest

from legalai.citations.validate import EvidenceItem, validate_answer
from legalai.ingestion.chunking import chunk_document
from legalai.ingestion.parsers import parse_document
from tests.test_retrieval import FakeEmbedder, drain, mk_matter, upload, emb  # noqa: F401

ROOT = Path(__file__).resolve().parents[3] / "benchmarks"
TOLERANCE = 0.03
THRESHOLDS = {"retrieval_recall_at_5": 0.85, "retrieval_mrr": 0.60, "citation_fabrication_rejected": 1.0,
              "quote_mutation_detected": 1.0, "valid_quote_accepted": 0.98, "wrong_source_flagged": 0.85,
              "uncited_claim_flagged": 1.0}
RESULTS: dict[str, float] = {}


def _contracts():
    return {p.name: p.read_bytes() for p in sorted((ROOT / "data" / "contracts").glob("*.txt"))}


def _record(name: str, value: float):
    RESULTS[name] = round(value, 4)


@pytest.fixture(scope="module", autouse=True)
def _write_report():
    yield
    if not RESULTS:
        return
    report = {"run_at": datetime.now(timezone.utc).isoformat(), "metrics": RESULTS, "thresholds": THRESHOLDS,
              "embedder": os.environ.get("BENCH_EMBEDDER", "fake")}
    (ROOT / "results").mkdir(exist_ok=True)
    (ROOT / "results" / "latest.json").write_text(json.dumps(report, indent=2))
    base = ROOT / "baseline.json"
    if os.environ.get("BENCH_UPDATE_BASELINE") or not base.exists():
        base.write_text(json.dumps({"metrics": RESULTS, "embedder": report["embedder"]}, indent=2))


def _baseline_check(name: str, value: float):
    base = ROOT / "baseline.json"
    if base.exists() and os.environ.get("BENCH_EMBEDDER", "fake") == json.loads(base.read_text()).get("embedder", "fake"):
        want = json.loads(base.read_text())["metrics"].get(name)
        if want is not None:
            assert value >= want - TOLERANCE, f"{name} regressed: {value} vs baseline {want}"


def test_retrieval_recall_and_mrr(make_api, emb, monkeypatch):
    if os.environ.get("BENCH_EMBEDDER") == "local":
        pytest.skip("live-embedder mode runs via scripts, not the patched unit environment")
    a = make_api("admin@example.com")
    m = mk_matter(a, "standard")
    for name, data in _contracts().items():
        upload(a, m["id"], name, data)
    drain()
    cases = json.loads((ROOT / "data" / "retrieval_cases.json").read_text())
    assert len(cases) >= 35
    ranks = {"hybrid": [], "lexical": [], "semantic": []}
    misses = []
    for c in cases:
        for mode in ranks:
            hits = a.post(f"/api/matters/{m['id']}/search", json={"query": c["q"], "k": 10, "mode": mode}).json()["hits"]
            r = next((i for i, h in enumerate(hits, 1) if h["document_title"] == c["doc"] and c["contains"] in h["text"]), None)
            ranks[mode].append(r)
            if mode == "hybrid" and (r is None or r > 5):
                misses.append((c["q"], r))
    n = len(cases)
    rec = lambda rs, k: sum(1 for r in rs if r is not None and r <= k) / n
    mrr = lambda rs: sum(1 / r for r in rs if r) / n
    for mode, rs in ranks.items():
        _record(f"retrieval_{mode}_recall_at_1", rec(rs, 1))
        _record(f"retrieval_{mode}_recall_at_5", rec(rs, 5))
    _record("retrieval_recall_at_5", rec(ranks["hybrid"], 5))
    _record("retrieval_mrr", mrr(ranks["hybrid"]))
    assert RESULTS["retrieval_recall_at_5"] >= THRESHOLDS["retrieval_recall_at_5"], f"misses: {misses}"
    assert RESULTS["retrieval_mrr"] >= THRESHOLDS["retrieval_mrr"]
    assert RESULTS["retrieval_hybrid_recall_at_5"] >= max(RESULTS["retrieval_lexical_recall_at_5"], RESULTS["retrieval_semantic_recall_at_5"]) - 0.05
    for k in ("retrieval_recall_at_5", "retrieval_mrr"):
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
