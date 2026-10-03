import json
import os
import uuid
from pathlib import Path
from datetime import date as Date
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session as DbSession

from ..audit import audit
from ..corpus.adapters import SourceError, validate_config
from ..corpus.presets import PRESETS
from ..corpus.refresh import get_library_matter
from ..config import get_settings
from ..db import get_db
from ..jobs.queue import enqueue
from ..models import CorpusSource, Document, DocumentVersion, User
from ..security import current_user, require_admin

router = APIRouter(prefix="/api/library", tags=["library"])
TREATMENT_TYPES = ("followed", "affirmed", "distinguished", "questioned", "criticized", "limited", "overruled", "reversed",
                   "vacated", "abrogated", "superseded_by", "repealed", "amended")


class SourceIn(BaseModel):
    name: str = Field(min_length=1, max_length=300)
    adapter: Literal["ecfr", "url", "uscode", "courtlistener"]
    config: dict
    jurisdiction: str = Field("", max_length=100)
    authority_type: Literal["statute", "regulation", "court_opinion", "court_rule", "administrative_guidance", "agency_material",
                            "official_form", "constitution", "treatise", "template"] = "regulation"
    refresh_hours: int = Field(24, ge=1, le=24 * 30)


class SourcePatch(BaseModel):
    enabled: bool | None = None
    refresh_hours: int | None = Field(None, ge=1, le=24 * 30)
    name: str | None = Field(None, max_length=300)


class Treatment(BaseModel):
    type: Literal[TREATMENT_TYPES]  # type: ignore[valid-type]
    citing: str = Field("", max_length=300)
    note: str = Field("", max_length=1000)
    date: Date | None = None
    source: str = Field("", max_length=500)


class TreatmentIn(BaseModel):
    treatment: list[Treatment] = Field(max_length=50)


def source_out(s: CorpusSource) -> dict:
    iso = lambda x: x.isoformat() if x else None
    return {"id": str(s.id), "name": s.name, "adapter": s.adapter, "config": s.config, "jurisdiction": s.jurisdiction,
            "authority_type": s.authority_type, "refresh_hours": s.refresh_hours, "enabled": s.enabled,
            "document_id": str(s.document_id) if s.document_id else None, "last_checked_at": iso(s.last_checked_at),
            "last_changed_at": iso(s.last_changed_at), "last_status": s.last_status}


@router.get("")
def list_library(user: User = Depends(current_user), db: DbSession = Depends(get_db)):
    lib = get_library_matter(db)
    db.commit()
    docs = db.scalars(select(Document).where(Document.matter_id == lib.id, Document.deleted_at.is_(None)).order_by(Document.title)).all()
    counts = dict(db.execute(select(DocumentVersion.document_id, func.count()).where(
        DocumentVersion.document_id.in_([d.id for d in docs])).group_by(DocumentVersion.document_id)).all()) if docs else {}
    out = []
    for d in docs:
        v = db.get(DocumentVersion, d.current_version_id) if d.current_version_id else None
        out.append({"id": str(d.id), "title": d.title, "authority_type": d.authority_type, "jurisdiction": d.jurisdiction,
                    "citation": d.citation_text, "source_url": d.source_url, "official_source": d.official_source,
                    "versions": counts.get(d.id, 0), "current_version": v.version_number if v else None,
                    "effective_from": v.effective_from.isoformat() if v and v.effective_from else None,
                    "retrieved_at": v.source_retrieved_at.isoformat() if v and v.source_retrieved_at else None,
                    "parse_status": v.parse_status if v else None, "embed_status": v.embed_status if v else None,
                    "treatment": d.treatment or [], "library_matter_id": str(lib.id)})
    return {"documents": out, "library_matter_id": str(lib.id)}


@router.get("/sources")
def list_sources(admin: User = Depends(require_admin), db: DbSession = Depends(get_db)):
    return [source_out(s) for s in db.scalars(select(CorpusSource).order_by(CorpusSource.name))]


@router.post("/sources", status_code=201)
def create_source(body: SourceIn, admin: User = Depends(require_admin), db: DbSession = Depends(get_db)):
    try:
        cfg = validate_config(body.adapter, body.config)
    except SourceError as e:
        raise HTTPException(422, str(e))
    s = CorpusSource(name=body.name, adapter=body.adapter, config=cfg, jurisdiction=body.jurisdiction,
                     authority_type=body.authority_type, refresh_hours=body.refresh_hours)
    db.add(s)
    db.flush()
    enqueue(db, "corpus_refresh", matter_id=None, user_id=admin.id, payload={"source_id": str(s.id)}, max_attempts=3)
    audit(db, "corpus.source_created", user_id=admin.id, object_type="corpus_source", object_id=s.id, adapter=body.adapter, config=cfg)
    db.commit()
    return source_out(s)


@router.patch("/sources/{sid}")
def patch_source(sid: uuid.UUID, body: SourcePatch, admin: User = Depends(require_admin), db: DbSession = Depends(get_db)):
    s = db.get(CorpusSource, sid)
    if not s:
        raise HTTPException(404, "Source not found")
    for k, v in body.model_dump(exclude_unset=True).items():
        if v is not None:
            setattr(s, k, v)
    audit(db, "corpus.source_updated", user_id=admin.id, object_type="corpus_source", object_id=s.id)
    db.commit()
    return source_out(s)


@router.delete("/sources/{sid}")
def delete_source(sid: uuid.UUID, admin: User = Depends(require_admin), db: DbSession = Depends(get_db)):
    s = db.get(CorpusSource, sid)
    if not s:
        raise HTTPException(404, "Source not found")
    db.delete(s)  # fetched documents and their versions stay (history is retained)
    audit(db, "corpus.source_deleted", user_id=admin.id, object_type="corpus_source", object_id=sid)
    db.commit()
    return {"ok": True}


@router.post("/sources/{sid}/refresh", status_code=202)
def refresh_now(sid: uuid.UUID, admin: User = Depends(require_admin), db: DbSession = Depends(get_db)):
    s = db.get(CorpusSource, sid)
    if not s:
        raise HTTPException(404, "Source not found")
    job = enqueue(db, "corpus_refresh", matter_id=None, user_id=admin.id, payload={"source_id": str(s.id)}, max_attempts=3)
    db.commit()
    return {"job_id": str(job.id)}


@router.put("/documents/{doc_id}/treatment")
def set_treatment(doc_id: uuid.UUID, body: TreatmentIn, admin: User = Depends(require_admin), db: DbSession = Depends(get_db)):
    """Record subsequent history (overruled, superseded, etc.) from an authoritative source. The system never infers it."""
    d = db.get(Document, doc_id)
    lib = get_library_matter(db)
    if not d or d.matter_id != lib.id:
        raise HTTPException(404, "Library document not found")
    d.treatment = [{**t.model_dump(), "date": t.date.isoformat() if t.date else None} for t in body.treatment]
    audit(db, "corpus.treatment_set", user_id=admin.id, matter_id=lib.id, object_type="document", object_id=d.id, count=len(d.treatment))
    db.commit()
    return {"treatment": d.treatment}


@router.get("/presets")
def presets(admin: User = Depends(require_admin), db: DbSession = Depends(get_db)):
    """Curated one-click starting points (all from official sources) with whether each is already added."""
    have = {(s.adapter, json.dumps(s.config, sort_keys=True)) for s in db.scalars(select(CorpusSource))}
    def present(p):
        cfgs = [i["config"] for i in p["items"]] if p.get("items") else [p["config"]]
        return all((p["adapter"], json.dumps(c, sort_keys=True)) in have for c in cfgs)
    return [{**p, "added": present(p)} for p in PRESETS]


class ImportEntry(BaseModel):
    citation: str = Field("", max_length=300)
    title: str = Field("", max_length=300)
    type: Literal[TREATMENT_TYPES]  # type: ignore[valid-type]
    citing: str = Field("", max_length=300)
    note: str = Field("", max_length=1000)
    date: Date | None = None
    source: str = Field("", max_length=500)


class ImportBody(BaseModel):
    entries: list[ImportEntry] = Field(max_length=2000)


@router.post("/treatment/import")
def import_treatment(body: ImportBody, admin: User = Depends(require_admin), db: DbSession = Depends(get_db)):
    """Bulk-load subsequent history (e.g. exported from a citator you license). Entries match library documents by exact
    citation or title (case-insensitive). Nothing is inferred; unmatched rows are reported back unchanged."""
    lib = get_library_matter(db)
    docs = db.scalars(select(Document).where(Document.matter_id == lib.id, Document.deleted_at.is_(None))).all()
    by_key = {}
    for d in docs:
        for k in (d.citation_text, d.title):
            if k:
                by_key.setdefault(k.strip().lower(), d)
    matched, unmatched = 0, []
    for e in body.entries:
        d = by_key.get(e.citation.strip().lower()) or by_key.get(e.title.strip().lower())
        if not d:
            unmatched.append(e.citation or e.title)
            continue
        entry = {"type": e.type, "citing": e.citing, "note": e.note, "date": e.date.isoformat() if e.date else None, "source": e.source}
        cur = list(d.treatment or [])
        if not any(x.get("type") == entry["type"] and x.get("citing") == entry["citing"] for x in cur):
            cur.append(entry)
            d.treatment = cur
        matched += 1
    audit(db, "corpus.treatment_imported", user_id=admin.id, matter_id=lib.id, matched=matched, unmatched=len(unmatched))
    db.commit()
    return {"matched": matched, "unmatched": unmatched}


# ---- state entity law and landmark cases (verified catalogs) ----------------------------------------------------
_CORPUS = Path(__file__).resolve().parents[1] / "corpus"


def _load(name: str):
    p = _CORPUS / name
    return json.loads(p.read_text(encoding="utf8")) if p.exists() else None


def _existing(db: DbSession) -> tuple[set[str], set[int]]:
    urls, ops = set(), set()
    for s in db.scalars(select(CorpusSource)):
        if s.adapter == "url":
            urls.add(s.config.get("url", ""))
        elif s.adapter == "courtlistener":
            ops.add(int(s.config.get("opinion_id", 0)))
    return urls, ops


@router.get("/states")
def list_states(admin: User = Depends(require_admin), db: DbSession = Depends(get_db)):
    """Every jurisdiction with what could be verified from official sources, and what is already in the library."""
    data = _load("states.json")
    if not data:
        return {"states": [], "generated": None}
    urls, _ = _existing(db)
    out = []
    for code, st in data["states"].items():
        kinds = {}
        for kind, k in st["kinds"].items():
            u = {i["url"] for i in k["items"]}
            kinds[kind] = {"title": k["title"], "citation": k["citation"], "available": bool(k["items"]), "pages": len(k["items"]),
                           "chars": sum(i.get("text_chars", 0) for i in k["items"]), "added": bool(u) and u <= urls,
                           "caveat": k["notes"] if (k["caveat"] or not k["items"]) else "", "shared": k.get("duplicate_of_other_kind", False)}
        out.append({"code": code, "name": st["name"], "kinds": kinds})
    return {"states": out, "generated": data["generated"]}


class AddState(BaseModel):
    kinds: list[Literal["llc", "corp", "securities"]] = Field(default_factory=lambda: ["llc", "corp"])


@router.post("/states/{code}", status_code=201)
def add_state(code: str, body: AddState, admin: User = Depends(require_admin), db: DbSession = Depends(get_db)):
    data = _load("states.json")
    st = (data or {}).get("states", {}).get(code.upper())
    if not st:
        raise HTTPException(404, "Unknown jurisdiction")
    urls, _ = _existing(db)
    created, skipped = 0, 0
    for kind in body.kinds:
        k = st["kinds"].get(kind)
        if not k:
            continue
        for it in k["items"]:
            if it["url"] in urls:
                skipped += 1
                continue
            src = CorpusSource(name=f"{st['name']} {k['label']}: {it['name']}", adapter="url", authority_type="statute", jurisdiction=st["name"],
                               refresh_hours=24 * 7, config={"url": it["url"], "title": f"{st['name']} {k['title']}: {it['name']}", "citation": k["citation"]})
            db.add(src)
            db.flush()
            enqueue(db, "corpus_refresh", matter_id=None, user_id=admin.id, payload={"source_id": str(src.id)}, max_attempts=3)
            urls.add(it["url"])
            created += 1
    audit(db, "corpus.state_added", user_id=admin.id, state=code.upper(), created=created, skipped=skipped, kinds=body.kinds)
    db.commit()
    return {"created": created, "skipped_existing": skipped}


@router.get("/cases")
def list_cases(admin: User = Depends(require_admin), db: DbSession = Depends(get_db)):
    cases = _load("cases.json") or []
    _, ops = _existing(db)
    groups: dict[str, list] = {}
    for c in cases:
        groups.setdefault(c["group"], []).append({**c, "added": c["opinion_id"] in ops})
    return {"groups": [{"name": g, "cases": cs} for g, cs in groups.items()], "token_configured": bool(get_settings().courtlistener_token or os.environ.get("COURTLISTENER_TOKEN"))}


class AddCases(BaseModel):
    group: str | None = None
    opinion_ids: list[int] | None = None


@router.post("/cases", status_code=201)
def add_cases(body: AddCases, admin: User = Depends(require_admin), db: DbSession = Depends(get_db)):
    cases = _load("cases.json") or []
    pick = [c for c in cases if (body.group and c["group"] == body.group) or (body.opinion_ids and c["opinion_id"] in body.opinion_ids)]
    if not pick:
        raise HTTPException(404, "No matching cases")
    _, ops = _existing(db)
    created = 0
    for c in pick:
        if c["opinion_id"] in ops:
            continue
        court = "Delaware" if c["group"].startswith("Delaware") else "United States"
        src = CorpusSource(name=c["name"], adapter="courtlistener", authority_type="court_opinion", jurisdiction=court, refresh_hours=24 * 30,
                           config={"opinion_id": c["opinion_id"]})
        db.add(src)
        db.flush()
        enqueue(db, "corpus_refresh", matter_id=None, user_id=admin.id, payload={"source_id": str(src.id)}, max_attempts=3)
        created += 1
    audit(db, "corpus.cases_added", user_id=admin.id, created=created)
    db.commit()
    return {"created": created}
