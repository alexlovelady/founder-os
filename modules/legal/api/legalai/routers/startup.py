"""Startup workflow: company setup, legal checklist, and the document catalog for the "Create a document" wizard."""
import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from ..audit import audit
from ..config import get_settings
from ..db import get_db
from ..ingestion.detect import STATES
from ..models import Document, DocumentVersion, Matter, MatterMember, PrivacyMode, User
from ..security import current_user, get_matter_access
from ..startup.catalog import CHECKLIST, ENTITY_TYPES, public_doc_types

router = APIRouter(prefix="/api", tags=["startup"])


@router.get("/startup/catalog")
def catalog(user: User = Depends(current_user)):
    return {"doc_types": public_doc_types(), "entity_types": ENTITY_TYPES, "states": STATES,
            "checklist": [{k: c[k] for k in ("id", "title", "why") if k in c} | {"draft": c.get("draft"), "manual": bool(c.get("manual")),
                                                                                   "optional": bool(c.get("optional"))} for c in CHECKLIST]}


class Onboarding(BaseModel):
    company_name: str = Field(min_length=1, max_length=200)
    entity_type: Literal["delaware_c_corp", "llc", "s_corp", "not_yet", "other"]
    state: str = Field("", max_length=100)
    stage: str = Field("", max_length=100)


@router.post("/onboarding", status_code=201)
def onboarding(body: Onboarding, user: User = Depends(current_user), db: DbSession = Depends(get_db)):
    """Create the user's company workspace (once). Documents about the company itself go here."""
    for m in db.scalars(select(Matter).join(MatterMember, MatterMember.matter_id == Matter.id)
                        .where(MatterMember.user_id == user.id, Matter.deleted_at.is_(None))):
        if (m.profile or {}).get("company"):
            raise HTTPException(409, "Your company workspace already exists")
    m = Matter(name=f"{body.company_name} – company documents", description="Your company's core legal documents.",
               jurisdiction=body.state, privacy_mode=get_settings().default_privacy_mode or PrivacyMode.private.value,
               profile={"company": True, "company_name": body.company_name, "entity_type": body.entity_type, "state": body.state,
                        "stage": body.stage, "checklist": {}})
    db.add(m)
    db.flush()
    db.add(MatterMember(matter_id=m.id, user_id=user.id, role="owner"))
    audit(db, "onboarding.completed", user_id=user.id, matter_id=m.id, object_type="matter", object_id=m.id, entity_type=body.entity_type)
    db.commit()
    return {"matter_id": str(m.id), "profile": m.profile}


class ProfilePatch(BaseModel):
    company_name: str | None = Field(None, max_length=200)
    entity_type: Literal["delaware_c_corp", "llc", "s_corp", "not_yet", "other"] | None = None
    state: str | None = Field(None, max_length=100)
    stage: str | None = Field(None, max_length=100)


@router.patch("/matters/{matter_id}/profile")
def patch_profile(matter_id: uuid.UUID, body: ProfilePatch, user: User = Depends(current_user), db: DbSession = Depends(get_db)):
    m, _ = get_matter_access(db, user, matter_id, "owner")
    prof = dict(m.profile or {})
    prof.update({k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None})
    m.profile = prof
    if body.state is not None:
        m.jurisdiction = body.state
    db.commit()
    return {"profile": m.profile}


def _doc_status(db: DbSession, matter_id: uuid.UUID) -> dict[str, list[dict]]:
    """agreement_type -> documents of that type in the matter (current version parsed)."""
    out: dict[str, list[dict]] = {}
    for d in db.scalars(select(Document).where(Document.matter_id == matter_id, Document.deleted_at.is_(None))):
        v = db.get(DocumentVersion, d.current_version_id) if d.current_version_id else None
        if d.agreement_type:
            out.setdefault(d.agreement_type, []).append({"id": str(d.id), "title": d.title, "parsed": bool(v and v.parse_status == "parsed")})
    return out


@router.get("/matters/{matter_id}/checklist")
def checklist(matter_id: uuid.UUID, user: User = Depends(current_user), db: DbSession = Depends(get_db)):
    m, role = get_matter_access(db, user, matter_id)
    prof = m.profile or {}
    entity = prof.get("entity_type", "other")
    marks = prof.get("checklist", {})
    found = _doc_status(db, m.id)
    items = []
    for c in CHECKLIST:
        if entity not in c["applies"]:
            continue
        docs = [d for t in c["types"] for d in found.get(t, [])]
        mark = marks.get(c["id"])
        status = "done" if docs else mark if mark in ("done", "not_needed") else "todo"
        items.append({"id": c["id"], "title": c["title"], "why": c["why"], "status": status, "documents": docs, "draft": c.get("draft"),
                      "manual": bool(c.get("manual")), "optional": bool(c.get("optional")), "detected": bool(docs)})
    required = [i for i in items if not i["optional"] and i["status"] != "not_needed"]
    return {"profile": prof, "items": items, "done": sum(1 for i in required if i["status"] == "done"), "total": len(required), "my_role": role}


class Mark(BaseModel):
    status: Literal["done", "not_needed", "todo"]


@router.put("/matters/{matter_id}/checklist/{item_id}")
def mark_item(matter_id: uuid.UUID, item_id: str, body: Mark, user: User = Depends(current_user), db: DbSession = Depends(get_db)):
    m, _ = get_matter_access(db, user, matter_id, "editor")
    if item_id not in {c["id"] for c in CHECKLIST}:
        raise HTTPException(404, "Unknown checklist item")
    prof = dict(m.profile or {})
    marks = dict(prof.get("checklist", {}))
    if body.status == "todo":
        marks.pop(item_id, None)
    else:
        marks[item_id] = body.status
    prof["checklist"] = marks
    m.profile = prof
    audit(db, "checklist.marked", user_id=user.id, matter_id=m.id, item=item_id, status=body.status)
    db.commit()
    return {"ok": True}
