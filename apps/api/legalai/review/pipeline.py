"""Contract review (spec 17.2/17.6): clause units -> structured extraction -> deterministic checks -> issue
assessment -> verification -> obligations and redline proposals -> auditable record."""
import hashlib
import json
import re
import uuid
from dataclasses import asdict
from datetime import date, datetime, timezone

from sqlalchemy import delete, select

from ..audit import audit
from ..config import Settings
from ..critic.critic import run_critic
from ..db import session_scope
from ..citations.quotes import find_quote
from ..ingestion.detect import DATE_PATTERNS, MONTH_NUM
from ..models import (ContractReview, Document, DocumentChunk, DocumentVersion, Obligation, Playbook, Redline)
from ..providers.base import LLMProvider
from ..llm_utils import Usage, _json_array, _model, _strip_think
from .checks import (broken_cross_references, classify_topics, detect_agreement_type, key_figures, missing_topics,
                     undefined_terms, unused_definitions)
from .prompts import (ASSESS_PROMPT, EXTRACT_PROMPT, PROMPT_VERSION, TOPIC_LIST, playbook_block)

MAX_CLAUSES = 80
BATCH_CHARS = 3200
RISKS = ("critical", "high", "medium", "low", "informational")
BASES = ("playbook", "general_risk", "internal_inconsistency", "missing_term")
FAVORS = ("customer", "vendor", "employer", "employee", "neutral", "unclear")

BUILTIN_PLAYBOOKS = {
    "builtin:balanced-commercial": {"name": "Balanced commercial (built-in)", "perspective": "neutral", "rules": [
        {"topic": "limitation_of_liability", "preferred": "Mutual cap tied to fees paid, excluding indemnity, confidentiality and willful misconduct",
         "fallback": "Cap at 12 months of fees", "red_flags": "Uncapped liability for one side only", "severity": "high"},
        {"topic": "termination", "preferred": "Mutual termination for uncured material breach with a cure period of 30 days",
         "fallback": "15 day cure period", "red_flags": "Termination at will for one party only", "severity": "medium"},
        {"topic": "indemnification", "preferred": "Mutual indemnity for third-party claims caused by each party's breach or negligence",
         "fallback": "Indemnity limited to IP infringement and gross negligence", "red_flags": "One-way broad indemnity", "severity": "high"},
        {"topic": "payment", "preferred": "Net 30 from receipt of undisputed invoice; right to dispute in good faith",
         "fallback": "Net 15", "red_flags": "Payment on signing with no dispute right; uncapped late fees", "severity": "medium"},
        {"topic": "governing_law_forum", "preferred": "Governing law and venue in a neutral or home jurisdiction, stated explicitly",
         "fallback": "", "red_flags": "No governing law, or exclusive venue far from the reviewing party", "severity": "medium"},
        {"topic": "intellectual_property", "preferred": "Each party keeps pre-existing IP; ownership of deliverables stated explicitly",
         "fallback": "", "red_flags": "Broad assignment of background IP", "severity": "high"},
    ]},
}


def _parse_deadline(text: str) -> date | None:
    for pat in DATE_PATTERNS:
        m = pat.search(text or "")
        if m:
            try:
                return date(int(m.group(3)), MONTH_NUM[m.group(1).lower()], int(m.group(2)))
            except ValueError:
                return None
    return None


def _batches(clauses: list[dict]) -> list[list[dict]]:
    out, cur, n = [], [], 0
    for c in clauses:
        if cur and n + len(c["text"]) > BATCH_CHARS:
            out.append(cur)
            cur, n = [], 0
        cur.append(c)
        n += len(c["text"])
    if cur:
        out.append(cur)
    return out


async def _chat_json(provider, model, prompt, usage, retries=1):
    for attempt in range(retries + 1):
        r = await provider.chat([{"role": "user", "content": prompt + ("" if attempt == 0 else "\n\nReturn ONLY the JSON array, nothing else.")}],
                                model, temperature=0)
        usage.add(r)
        arr = _json_array(_strip_think(r.content))
        if arr is not None:
            return arr
    return None


def _norm_enum(v, allowed, default):
    v = str(v or "").strip().lower()
    return v if v in allowed else default


async def run_review(review_id: uuid.UUID, provider: LLMProvider, settings: Settings) -> dict:
    usage = Usage()
    warnings: list[str] = []
    with session_scope() as db:
        rv = db.get(ContractReview, review_id)
        ver = db.get(DocumentVersion, rv.version_id)
        doc = db.get(Document, rv.document_id)
        chunks = db.scalars(select(DocumentChunk).where(DocumentChunk.version_id == ver.id)
                            .order_by(DocumentChunk.chunk_index)).all()
        full_text = ver.extracted_text or ""
        matter_id, perspective = rv.matter_id, rv.perspective
        pb_id = rv.playbook_id
        pb = None
        if pb_id:
            row = db.get(Playbook, pb_id)
            if row:
                pb = {"name": row.name, "perspective": row.perspective, "rules": row.rules}
        want_critic = bool((rv.result or {}).get("critic"))
        pb_builtin = BUILTIN_PLAYBOOKS.get((rv.result or {}).get("builtin_playbook")) if rv.result else None
        pb = pb or pb_builtin
        clauses = [{"id": f"CL-{i:03d}", "chunk_id": str(c.id), "text": c.text, "section": c.section_number,
                    "heading_path": c.heading_path, "page": c.page, "char_start": c.char_start} for i, c in enumerate(chunks[:MAX_CLAUSES], 1)]
        if len(chunks) > MAX_CLAUSES:
            warnings.append(f"Only the first {MAX_CLAUSES} of {len(chunks)} passages were reviewed.")
        doc_id, ver_id, doc_title, create_by = doc.id, ver.id, doc.title, rv.created_by

    agreement_type = detect_agreement_type(full_text)
    perspective = perspective if perspective != "neutral" or not pb else pb.get("perspective", "neutral")
    by_id = {c["id"]: c for c in clauses}

    # 1. structured extraction per batch (fast/extraction model)
    ext_model = _model(provider, settings, "extraction")
    extracted: dict[str, dict] = {}
    for batch in _batches(clauses):
        text = "\n\n".join(f"[{c['id']}] ({' > '.join(c['heading_path'])})\n{c['text']}" for c in batch)
        arr = await _chat_json(provider, ext_model, EXTRACT_PROMPT.format(topics=TOPIC_LIST, clauses=text), usage)
        if arr is None:
            warnings.append(f"Could not extract structured data for {batch[0]['id']}–{batch[-1]['id']}.")
            continue
        for o in arr:
            if isinstance(o, dict) and o.get("clause") in by_id:
                extracted[o["clause"]] = o

    # 2. deterministic checks
    undef = undefined_terms(full_text)
    unused = unused_definitions(full_text)
    broken = broken_cross_references(full_text)
    pb_topics = [r.get("topic", "") for r in (pb["rules"] if pb else [])]
    missing = missing_topics(full_text, agreement_type, pb_topics)
    figs = key_figures(full_text)
    findings = []
    findings += [f"Missing topic: {t}" for t in missing]
    findings += [f"Capitalized term used but not defined: {u['term']} ({u['uses']} uses)" for u in undef[:8]]
    findings += [f"Cross-reference to something not found in this document: {b['reference']}" for b in broken[:8]]
    findings += [f"Defined but never used: {u}" for u in unused[:5]]

    # 3. issue assessment (deep model)
    table = "\n".join(f"{c['id']} [{extracted.get(c['id'], {}).get('topic') or ','.join(classify_topics(c['text'])[:2]) or 'other'}] "
                      f"{(extracted.get(c['id'], {}).get('summary') or c['text'][:160]).strip()}" for c in clauses)
    arr = await _chat_json(provider, _model(provider, settings, "deep"), ASSESS_PROMPT.format(
        agreement_type=agreement_type, perspective=perspective, playbook=playbook_block(pb["rules"], pb["name"]) if pb else playbook_block([], ""),
        findings="\n".join(f"- {f}" for f in findings) or "- none", table=table), usage)
    if arr is None:
        warnings.append("Issue assessment could not be parsed; only deterministic findings are shown.")
        arr = []

    # 4. verify and normalize issues (the model cannot reference unknown clauses or fabricate quotes)
    issues = []
    for i, o in enumerate(arr[:15], 1):
        if not isinstance(o, dict):
            continue
        refs = [c for c in (o.get("clauses") or []) if c in by_id]
        why = str(o.get("why") or "").strip()
        if not why or (not refs and o.get("basis") not in ("missing_term",)):
            continue
        quote = str(o.get("quote") or "").strip()
        verified = None
        if quote and refs:
            verified = bool(find_quote(quote, [by_id[c]["text"] for c in refs]))
            if not verified:
                warnings.append(f"Issue \"{str(o.get('title'))[:60]}\": quote was not verbatim in the clause and was removed.")
                quote = ""
        rev = str(o.get("suggested_revision") or "").strip()
        issues.append({"id": f"ISS-{i:02d}", "clauses": refs, "title": str(o.get("title") or "Issue")[:200],
                       "risk": _norm_enum(o.get("risk"), RISKS, "medium"), "basis": _norm_enum(o.get("basis"), BASES, "general_risk"),
                       "why": why, "favors": _norm_enum(o.get("favors"), FAVORS, "unclear"), "quote": quote,
                       "quote_verified": verified, "playbook_rule": str(o.get("playbook_rule") or ""),
                       "suggested_revision": rev if len(refs) == 1 and rev else ""})
    for t in missing:  # deterministic missing-term issues are always surfaced, as informational/medium
        if not any(t in (x["why"] + x["title"]).lower().replace(" ", "_") for x in issues):
            issues.append({"id": f"ISS-M{len(issues) + 1:02d}", "clauses": [], "title": f"No {t.replace('_', ' ')} provision found",
                           "risk": "medium" if t in ("limitation_of_liability", "termination", "governing_law_forum") else "low",
                           "basis": "missing_term", "why": f"The text contains no language that appears to address {t.replace('_', ' ')}. "
                           "Confirm whether this is intentional.", "favors": "unclear", "quote": "", "quote_verified": None,
                           "playbook_rule": t if t in pb_topics else "", "suggested_revision": ""})
    issues.sort(key=lambda x: RISKS.index(x["risk"]))

    # 5. obligations
    obligations = []
    for cid, o in extracted.items():
        for ob in o.get("obligations") or []:
            if isinstance(ob, dict) and str(ob.get("obligation") or "").strip():
                dl = str(ob.get("deadline") or "")[:300]
                obligations.append({"clause": cid, "party": str(ob.get("party") or "")[:300], "obligation": str(ob["obligation"]),
                                    "trigger": str(ob.get("trigger") or ""), "deadline_text": dl, "deadline_date": _parse_deadline(dl),
                                    "recurrence": str(ob.get("recurrence") or "")[:200],
                                    "confidence": _norm_enum(ob.get("confidence"), ("low", "medium", "high"), "medium")})

    out_clauses = [{"id": c["id"], "chunk_id": c["chunk_id"], "section": c["section"], "heading_path": c["heading_path"], "page": c["page"],
                    "text": c["text"], "topic": (extracted.get(c["id"]) or {}).get("topic") or (classify_topics(c["text"]) or ["other"])[0],
                    "summary": (extracted.get(c["id"]) or {}).get("summary", ""), "favors": _norm_enum((extracted.get(c["id"]) or {}).get("favors"), FAVORS, "unclear"),
                    "rights": (extracted.get(c["id"]) or {}).get("rights") or [], "unusual": (extracted.get(c["id"]) or {}).get("unusual", ""),
                    "extracted": c["id"] in extracted} for c in clauses]
    critic = None
    if want_critic:
        text = "\n".join(f"{i['id']} [{i['risk']}] {i['title']}: {i['why']}" for i in issues)
        critic = await run_critic(provider, settings, usage, kind="contract review (issue list)", output_text=text or "(no issues)",
                                  evidence=[{"cite_id": c["id"], "title": c["section"] or c["id"], "text": c["text"], "flags": [], "jurisdiction": ""} for c in clauses])
    counts = {r: sum(1 for i in issues if i["risk"] == r) for r in RISKS}
    result = {"agreement_type": agreement_type, "perspective": perspective, "playbook": pb["name"] if pb else None, "clauses": out_clauses,
              "issues": issues, "missing_terms": missing, "undefined_terms": undef, "unused_definitions": unused,
              "broken_cross_references": broken, "figures": asdict(figs), "risk_counts": counts, "warnings": warnings,
              "obligation_count": len(obligations), "critic": critic}
    out_hash = hashlib.sha256(json.dumps(result, sort_keys=True, default=str).encode()).hexdigest()

    with session_scope() as db:
        rv = db.get(ContractReview, review_id)
        rv.status, rv.provider, rv.model, rv.prompt_version = "complete", provider.name, _model(provider, settings, "deep"), PROMPT_VERSION
        rv.result, rv.output_hash, rv.finished_at = result, out_hash, datetime.now(timezone.utc)
        db.execute(delete(Obligation).where(Obligation.version_id == ver_id, Obligation.status == "open", Obligation.review_id.isnot(None)))
        for o in obligations:
            c = by_id[o["clause"]]
            db.add(Obligation(matter_id=matter_id, document_id=doc_id, version_id=ver_id, review_id=review_id, party=o["party"],
                              obligation=o["obligation"], trigger=o["trigger"], deadline_text=o["deadline_text"],
                              deadline_date=o["deadline_date"], recurrence=o["recurrence"], source_chunk_id=uuid.UUID(c["chunk_id"]),
                              source_clause=" > ".join(c["heading_path"]) or c["section"] or o["clause"], confidence=o["confidence"]))
        for i in issues:
            if i["suggested_revision"]:
                c = by_id[i["clauses"][0]]
                db.add(Redline(matter_id=matter_id, document_id=doc_id, version_id=ver_id, review_id=review_id,
                               chunk_id=uuid.UUID(c["chunk_id"]), clause_label=" > ".join(c["heading_path"]) or c["section"] or c["id"],
                               original=c["text"], proposed=i["suggested_revision"], reason=i["why"], risk=i["risk"],
                               support={"issue": i["id"], "basis": i["basis"], "playbook_rule": i["playbook_rule"], "quote": i["quote"]},
                               created_by=create_by))
        audit(db, "contract_review.completed", user_id=create_by, matter_id=matter_id, object_type="contract_review",
              object_id=review_id, provider=provider.name, prompt_version=PROMPT_VERSION, output_hash=out_hash,
              issues=len(issues), obligations=len(obligations), version_id=str(ver_id))
    return {"review_id": str(review_id), "model": ext_model, "prompt_tokens": usage.prompt, "completion_tokens": usage.completion}
