"""Drafting and redline generation (spec 17.3/17.4). The model proposes text; deterministic checks list every
placeholder, every specific (amount, date, percentage) the user did not provide, undefined terms and broken
cross-references, so nothing invented passes silently."""
import hashlib
import json
import re
import uuid
from datetime import datetime, timezone

from ..audit import audit
from ..config import Settings
from ..critic.critic import run_critic
from ..db import session_scope
from ..models import Draft, DocumentChunk, Matter, Redline
from ..providers.base import LLMProvider
from ..llm_utils import Usage, _json_array, _model, _strip_think
from ..retrieval.hybrid import hybrid_search
from ..review.checks import DURATION, MONEY, PERCENT, broken_cross_references, undefined_terms
from .prompts import PROMPT_VERSION, SYSTEM, build_user

PLACEHOLDER = re.compile(r"\[●[^\]\n]{1,80}\]")
DATE_RX = re.compile(r"\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\b|\b(?:19|20)\d{2}\b", re.I)


def _json_obj(text: str):
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        return None
    try:
        v = json.loads(m.group(0))
        return v if isinstance(v, dict) else None
    except ValueError:
        return None


def specifics(text: str) -> list[str]:
    found = set()
    for rx in (MONEY, DURATION, PERCENT, DATE_RX):
        found |= {re.sub(r"\s+", " ", m.strip().lower()) for m in rx.findall(text)}
    return sorted(found)


def unverified_specifics(content: str, provided: str) -> list[str]:
    allowed = " ".join(re.sub(r"\s+", " ", provided.lower()).split())
    nums = re.sub(r"[,$]", "", allowed)
    out = []
    for s in specifics(content):
        if s in allowed or re.sub(r"[,$]", "", s) in nums:
            continue
        out.append(s)
    return out


async def generate(provider: LLMProvider, settings: Settings, usage: Usage, *, mode: str, doc_type: str, instructions: str,
                   facts: dict, jurisdiction: str, source_text: str, perspective: str, reference: list[dict]) -> tuple[dict, str]:
    model = _model(provider, settings, "deep")
    user = build_user(mode, doc_type, instructions, facts, jurisdiction, source_text, perspective, reference)
    r = await provider.chat([{"role": "system", "content": SYSTEM}, {"role": "user", "content": user}], model, temperature=0.2)
    usage.add(r)
    raw = _strip_think(r.content)
    obj = _json_obj(raw)
    if not obj or not isinstance(obj.get("content"), str):
        obj = {"content": raw, "placeholders": [], "assumptions": ["The model did not return structured output; review carefully."],
               "needs_attorney_review": ["Entire draft"]}
    return obj, model


def _checks(content: str, provided: str, declared: list) -> dict:
    found = sorted({m.group(0) for m in PLACEHOLDER.finditer(content)})
    declared_names = {str(p.get("name", "")).strip() for p in declared if isinstance(p, dict)}
    return {"placeholders_in_text": found,
            "declared_placeholders_missing_from_text": sorted(n for n in declared_names if n and f"[●{n}]" not in content),
            "unverified_specifics": unverified_specifics(content, provided),
            "undefined_terms": undefined_terms(content), "broken_cross_references": broken_cross_references(content)}


async def run_draft(draft_id: uuid.UUID, provider: LLMProvider, settings: Settings) -> dict:
    usage = Usage()
    with session_scope() as db:
        d = db.get(Draft, draft_id)
        matter = db.get(Matter, d.matter_id)
        inp = d.inputs or {}
        source_text = inp.get("source_text", "")
        if inp.get("chunk_id") and not source_text:
            c = db.get(DocumentChunk, uuid.UUID(inp["chunk_id"]))
            if c and c.matter_id == matter.id:  # never pull text across matters
                source_text = c.text
        mode, doc_type, instructions, facts = d.mode, d.doc_type, d.instructions, inp.get("facts") or {}
        want_critic = bool(inp.get("critic"))
        jur = inp.get("jurisdiction") or matter.jurisdiction
        perspective = inp.get("perspective", "neutral")
        res = await hybrid_search(db, matter, instructions[:500], settings, k=5, jurisdictions=[jur] if inp.get("jurisdiction") else None)
        reference = [{"cite_id": h.cite_id, "title": h.doc.title, "text": h.chunk.text, "chunk_id": str(h.chunk.id)} for h in res.hits]
        warnings = list(res.warnings)
    obj, model = await generate(provider, settings, usage, mode=mode, doc_type=doc_type, instructions=instructions, facts=facts,
                                jurisdiction=jur, source_text=source_text, perspective=perspective, reference=reference)
    content = obj["content"].strip()
    provided = " ".join([instructions, json.dumps(facts), source_text, jur])
    checks = _checks(content, provided, obj.get("placeholders") or [])
    if checks["unverified_specifics"]:
        warnings.append("The draft contains specifics you did not provide. Verify or replace each one: " + ", ".join(checks["unverified_specifics"][:8]))
    critic = None
    if want_critic:
        critic = await run_critic(provider, settings, usage, kind="legal draft", output_text=content, facts=provided,
                                  evidence=[{"cite_id": r["cite_id"], "title": r["title"], "text": r["text"], "flags": [], "jurisdiction": ""} for r in reference])
    result = {"critic": critic, "placeholders": obj.get("placeholders") or [], "assumptions": obj.get("assumptions") or [],
              "needs_attorney_review": obj.get("needs_attorney_review") or [], "checks": checks, "warnings": warnings,
              "reference": [{k: r[k] for k in ("cite_id", "title", "chunk_id")} for r in reference]}
    h = hashlib.sha256(content.encode()).hexdigest()
    with session_scope() as db:
        d = db.get(Draft, draft_id)
        d.status, d.content, d.result, d.provider, d.model = "complete", content, result, provider.name, model
        d.prompt_version, d.output_hash, d.finished_at = PROMPT_VERSION, h, datetime.now(timezone.utc)
        audit(db, "draft.completed", user_id=d.created_by, matter_id=d.matter_id, object_type="draft", object_id=d.id,
              provider=provider.name, model=model, prompt_version=PROMPT_VERSION, output_hash=h, mode=d.mode)
    return {"draft_id": str(draft_id), "model": model, "prompt_tokens": usage.prompt, "completion_tokens": usage.completion}


async def run_redline_generation(redline_id: uuid.UUID, provider: LLMProvider, settings: Settings) -> dict:
    usage = Usage()
    with session_scope() as db:
        r = db.get(Redline, redline_id)
        matter = db.get(Matter, r.matter_id)
        original, instruction = r.original, (r.support or {}).get("instruction") or "Improve this clause."
        perspective = (r.support or {}).get("perspective", "neutral")
        jur = matter.jurisdiction
    obj, model = await generate(provider, settings, usage, mode="rewrite_clause", doc_type="", instructions=instruction, facts={},
                                jurisdiction=jur, source_text=original, perspective=perspective, reference=[])
    proposed = obj["content"].strip()
    checks = _checks(proposed, " ".join([instruction, original]), obj.get("placeholders") or [])
    with session_scope() as db:
        r = db.get(Redline, redline_id)
        r.proposed = proposed
        r.reason = "; ".join(obj.get("assumptions") or []) or r.reason
        r.support = {**(r.support or {}), "checks": checks, "needs_attorney_review": obj.get("needs_attorney_review") or [],
                     "model": model, "prompt_version": PROMPT_VERSION}
        audit(db, "redline.generated", user_id=r.created_by, matter_id=r.matter_id, object_type="redline", object_id=r.id,
              provider=provider.name, model=model, prompt_version=PROMPT_VERSION)
    return {"redline_id": str(redline_id), "model": model, "prompt_tokens": usage.prompt, "completion_tokens": usage.completion}
