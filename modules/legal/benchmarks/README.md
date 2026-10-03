# Benchmarks

Run: `cd api && pytest tests/test_benchmarks.py` (also part of the normal test run).

| Suite | What it measures | Gate |
|---|---|---|
| Retrieval | recall@1/@5 and MRR for hybrid, lexical-only and semantic-only search over 3 contracts / 39 questions with known answers | recall@5 >= 0.85, MRR >= 0.60 |
| Citation validation | 197 adversarial cases generated from the same contracts: fabricated IDs, one-word and one-number quote mutations, claims cited to the wrong passage, uncited claims, and valid quotes that must NOT be rejected | fabricated rejected 100%, mutated quotes detected 100%, valid quotes accepted >= 98%, wrong-source >= 85%, uncited 100% |

`results/latest.json` is rewritten on every run. `baseline.json` is the committed reference: a metric more than 0.03
below it fails the test, so prompt, retrieval or model changes cannot silently regress. Refresh deliberately with
`BENCH_UPDATE_BASELINE=1`.

Other spec section 30 items are covered by dedicated tests (`tests/`): jurisdiction and date handling
(`test_research.py`, `test_citations.py`), current vs superseded authority and dated versions (`test_corpus.py`),
contract clause extraction, defined terms and cross-references (`test_review.py`, `test_checks.py`), hallucinated-citation
rejection (`test_citations.py`), conflicting authority (`test_critic.py`), GPU-offline queueing and external-fallback
privacy (`test_jobs.py`, `test_hardening.py`), matter isolation (every router has a cross-matter test).

## Limits you should know about
* The retrieval numbers use a deterministic bag-of-words stand-in for the embedding model, so they mostly measure the
  lexical path, the fusion and the scoping. They are a regression gate, not a quality claim about Voyage or the local model.
  Re-measure with the real embedders before trusting semantic quality.
* 39 retrieval questions and 3 contracts is far below the 100+ question set the spec asks for before treating the
  system as dependable. Add real matters' questions (with expected passages) to `data/retrieval_cases.json`.
* The validator checks that sources *lexically and numerically* support a claim (optionally upgraded by a model
  verdict). It does not prove legal entailment.
