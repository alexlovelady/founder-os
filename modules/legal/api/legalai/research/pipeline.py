"""Research workflow (spec 17.1): variants -> hybrid retrieval -> grounded generation -> citation/quote
validation (+ one correction pass) -> coverage labels -> auditable run record."""
import hashlib
import json
import re
import uuid
from dataclasses import asdict
from datetime import datetime, timezone

from ..audit import audit
from ..critic.critic import run_critic
from ..citations.validate import (CITE_ID, EvidenceItem, ValidatedAnswer, split_segments, validate_answer)
from ..config import Settings
from ..llm_utils import Usage, _json_array, _model, _strip_think
from ..db import session_scope
from ..models import Matter, ResearchRun
from ..providers.base import LLMProvider
from ..retrieval.hybrid import hybrid_search
from .prompts import (CORRECTION_TEMPLATE, ENTAILMENT_PROMPT, PROMPT_VERSION, VARIANT_PROMPT, build_messages)

MAX_ENTAILMENT_CLAIMS = 12
EVIDENCE_K = 10
NO_SOURCES = ("No relevant passages were found in this matter's documents, so no answer can be given. "
              "Upload the relevant documents or authorities, or rephrase the question.")


def _location(page, page_end, heading_path, section) -> str:
    bits = []
    if page:
        bits.append(f"p. {page}" if not page_end or page_end == page else f"pp. {page}-{page_end}")
    if section:
        bits.append(f"section {section}")
    if heading_path:
        bits.append(" > ".join(heading_path))
    return " · ".join(bits)


async def _variants(provider, settings, question, usage) -> list[str]:
    try:
        r = await provider.chat([{"role": "user", "content": VARIANT_PROMPT.format(question=question)}],
                                _model(provider, settings, "fast"), temperature=0)
        usage.add(r)
        arr = _json_array(_strip_think(r.content)) or []
        return [x.strip() for x in arr if isinstance(x, str) and 3 < len(x) < 300][:3]
    except Exception:  # noqa: BLE001 - variants are an optimization; never fail the run on them
        return []


async def _entailment(provider, settings, answer, evidence, usage) -> dict[int, str]:
    by_id = {e.cite_id: e for e in evidence}
    items, idx = [], []
    for n, (sent, _sec, _ln) in enumerate(split_segments(answer)):
        ids = [i for i in dict.fromkeys(CITE_ID.findall(sent)) if i in by_id]
        if ids and not sent.lstrip().startswith("#") and len(items) < MAX_ENTAILMENT_CLAIMS:
            claim = re.sub(r"\[[^\]]*\]", "", sent).strip()
            src = "\n".join(by_id[i].text[:900] for i in ids)
            items.append(f'{len(items) + 1}. CLAIM: {claim}\nSOURCE: """{src}"""')
            idx.append(n)
    if not items:
        return {}
    try:
        r = await provider.chat([{"role": "user", "content": ENTAILMENT_PROMPT.format(items="\n\n".join(items))}],
                                _model(provider, settings, "critic"), temperature=0)
        usage.add(r)
        out = {}
        for row in _json_array(_strip_think(r.content)) or []:
            i, v = row.get("i"), str(row.get("verdict", "")).lower()
            if isinstance(i, int) and 1 <= i <= len(idx) and v in ("yes", "partial", "no"):
                out[idx[i - 1]] = v
        return out
    except Exception:  # noqa: BLE001
        return {}


def _problems(v: ValidatedAnswer) -> list[str]:
    s = v.summary()
    out = []
    if s["fabricated_citations"]:
        out.append(f"- You cited IDs that do not exist: {', '.join(s['fabricated_citations'])}.")
    if s["quotes_failed"]:
        bad = [q["quote"][:80] for q in v.quotes if q["status"] == "mismatch"]
        out.append("- These quotations are not verbatim in any passage: " + "; ".join(f'"{b}"' for b in bad))
    return out


def coverage_labels(hits, jurisdiction: str, answer_text: str, summary: dict, currentness_days: int = 30) -> list[dict]:
    if not hits:
        return [{"label": "Insufficient authority coverage", "reason": "No relevant passages were retrieved."}]
    docs = {h.chunk.document_id for h in hits}
    primary = [h for h in hits if h.authority.label in ("primary", "user_document")]
    external = [h for h in hits if h.authority.label in ("primary", "secondary") and h.doc.authority_type != "user_document"]
    flagged = {f for h in hits for f in h.authority.flags}
    out = []
    if len(hits) >= 3 and len(docs) >= 2 and primary and "superseded" not in flagged and "jurisdiction_mismatch" not in flagged:
        label = "Strong authority coverage"
    elif len(hits) >= 2:
        label = "Moderate authority coverage"
    else:
        label = "Limited authority coverage"
    reason = f"{len(hits)} passage(s) from {len(docs)} document(s)"
    if not external:
        reason += "; based only on documents uploaded to this matter — no statutes, regulations or case law were available to check"
    out.append({"label": label, "reason": reason + "."})
    if not jurisdiction or flagged & {"jurisdiction_unknown", "jurisdiction_mismatch"}:
        out.append({"label": "Jurisdiction uncertain",
                    "reason": "The matter or some sources have no recorded jurisdiction, or a source is from a different one."})
    if flagged & {"superseded", "not_in_effect_on_date", "negative_treatment"}:
        out.append({"label": "Superseded or out-of-date sources retrieved",
                    "reason": "Some retrieved sources are marked superseded or were not in effect on the relevant date."})
    if any(h.ocr_applied for h in hits):
        out.append({"label": "Some sources are OCR text", "reason": "Verbatim checks passed against OCR-recognized text, which may differ from the original image where recognition erred."})
    ext_hits = [h for h in hits if h.doc.authority_type != "user_document"]
    stale = [h for h in ext_hits if not h.retrieved_at or (datetime.now(timezone.utc) - h.retrieved_at).days > currentness_days]
    if stale:
        out.append({"label": "Currentness not verified as of the requested date",
                    "reason": f"{len(stale)} external authority passage(s) have no recent verified retrieval from the official source."})
    if any(h.doc.court_level or h.doc.authority_type == "court_opinion" for h in ext_hits) and not any(h.doc.treatment for h in ext_hits):
        out.append({"label": "No treatment data", "reason": "No subsequent-history or citator information is recorded for the cases cited, so "
                    "whether they remain good law has not been established."})
    m = re.search(r"##\s*Unresolved Facts[^\n]*\n(.*?)(?=\n##|\Z)", answer_text, re.S | re.I)
    if m and m.group(1).strip() and not re.match(r"\W*none\b", m.group(1).strip(), re.I):
        out.append({"label": "Additional facts required", "reason": "The answer lists open facts or assumptions."})
    if summary["unsupported"] or summary["uncited"]:
        out.append({"label": "Some statements are not verified",
                    "reason": f"{summary['unsupported']} statement(s) are not supported by their cited source and "
                              f"{summary['uncited']} have no citation."})
    if summary["fabricated_citations"] or summary["quotes_failed"]:
        out.append({"label": "Invalid citations or quotes removed or flagged",
                    "reason": "The model cited sources that were not retrieved or quoted text that is not in the sources."})
    return out


async def run_research(run_id: uuid.UUID, provider: LLMProvider, settings: Settings) -> dict:
    usage = Usage()
    with session_scope() as db:
        run = db.get(ResearchRun, run_id)
        matter = db.get(Matter, run.matter_id)
        retrieval_init = dict(run.retrieval or {})
        question, jur, as_of, require_current = (run.question, run.jurisdiction, run.as_of,
                                          bool(retrieval_init.get("require_current")))
        matter_info = {"name": matter.name, "description": matter.description}
        matter_jur = jur or matter.jurisdiction
        privacy_mode = matter.privacy_mode
        variants = await _variants(provider, settings, question, usage)
        res = await hybrid_search(db, matter, question, settings, k=EVIDENCE_K, variants=variants,
                                  jurisdictions=[jur] if jur else None, as_of=as_of, require_current=require_current)
        hits, warnings, emb_model, mode_used = res.hits, list(res.warnings), res.embedding_model, res.mode_used

    evidence_items, evidence_dicts = [], []
    for h in hits:
        c = h.chunk
        loc = _location(c.page, c.page_end, c.heading_path, c.section_number)
        evidence_items.append(EvidenceItem(h.cite_id, str(c.id), c.text, str(c.document_id), h.doc.title,
                                           h.version_number, c.page, c.char_start, list(h.authority.flags)))
        evidence_dicts.append({"cite_id": h.cite_id, "chunk_id": str(c.id), "document_id": str(c.document_id),
                               "version_id": str(c.version_id), "title": h.doc.title, "version_number": h.version_number,
                               "page": c.page, "page_end": c.page_end, "heading_path": c.heading_path,
                               "section_number": c.section_number, "location": loc, "text": c.text,
                               "authority_type": h.doc.authority_type, "authority_label": h.authority.label,
                               "jurisdiction": h.doc.jurisdiction, "flags": list(h.authority.flags),
                               "char_start": c.char_start, "char_end": c.char_end, "ocr": h.ocr_applied})

    model = None
    regenerated = False
    if not hits:
        raw = answer = NO_SOURCES
        validated = ValidatedAnswer(answer, [], [], [])
    else:
        model = _model(provider, settings, "deep")
        msgs = build_messages(question, matter_info, evidence_dicts, as_of.isoformat() if as_of else None, matter_jur)
        r = await provider.chat(msgs, model, temperature=0.1)
        usage.add(r)
        raw = _strip_think(r.content)
        validated = validate_answer(raw, evidence_items, user_text=question)
        problems = _problems(validated)
        if problems:  # one correction pass; keep whichever draft has fewer hard problems
            r2 = await provider.chat(msgs + [{"role": "assistant", "content": raw},
                                             {"role": "user", "content": CORRECTION_TEMPLATE.format(
                                                 problems="\n".join(problems), ids=", ".join(e.cite_id for e in evidence_items))}],
                                     model, temperature=0.1)
            usage.add(r2)
            second = validate_answer(_strip_think(r2.content), evidence_items, user_text=question)
            if second.problem_count <= validated.problem_count:
                validated, raw, regenerated = second, _strip_think(r2.content), True
        verdicts = await _entailment(provider, settings, raw, evidence_items, usage)
        if verdicts:
            validated = validate_answer(raw, evidence_items, user_text=question, llm_verdicts=verdicts)

    critic_on = bool((retrieval_init or {}).get("critic", True)) and bool(hits)
    critic = None
    if critic_on:
        cited = {c for s in validated.segments for c in s.cites}
        critic = await run_critic(provider, settings, usage, kind="legal research answer", output_text=validated.cleaned,
                                  evidence=evidence_dicts, facts=f"{question}\n{matter_info.get('description', '')}",
                                  flags_cited=[e for e in evidence_dicts if e["cite_id"] in cited])
    summary = validated.summary()
    if validated.fabricated:
        warnings.append("Citations to sources that were not retrieved were removed from the answer.")
    if summary["quotes_failed"]:
        warnings.append("Some quotations could not be found verbatim in the sources and are flagged.")
    coverage = coverage_labels(hits, matter_jur, validated.cleaned, summary, settings.currentness_days)
    out_hash = hashlib.sha256(validated.cleaned.encode()).hexdigest()

    with session_scope() as db:
        run = db.get(ResearchRun, run_id)
        run.status, run.provider, run.model = "complete", provider.name, model
        run.prompt_version, run.privacy_mode = PROMPT_VERSION, privacy_mode
        run.answer, run.output_hash = validated.cleaned, out_hash
        run.result = {"segments": [asdict(s) for s in validated.segments], "quotes": validated.quotes,
                      "evidence": evidence_dicts, "coverage": coverage, "warnings": warnings,
                      "regenerated": regenerated, "variants": variants, "critic": critic, "raw_answer": raw if raw != validated.cleaned else None}
        run.retrieval = {"chunk_ids": [e["chunk_id"] for e in evidence_dicts],
                         "version_ids": sorted({e["version_id"] for e in evidence_dicts}),
                         "embedding_model": emb_model, "mode": mode_used, "k": EVIDENCE_K,
                         "jurisdiction": jur or None, "as_of": as_of.isoformat() if as_of else None,
                         "require_current": require_current}
        run.validation = summary
        run.finished_at = datetime.now(timezone.utc)
        audit(db, "research.completed", user_id=run.created_by, matter_id=run.matter_id, object_type="research_run",
              object_id=run.id, provider=provider.name, model=model, prompt_version=PROMPT_VERSION,
              privacy_mode=privacy_mode, citations=[e["cite_id"] for e in evidence_dicts],
              output_hash=out_hash, problems=validated.problem_count)
    return {"run_id": str(run_id), "model": model or "", "prompt_tokens": usage.prompt,
            "completion_tokens": usage.completion}
