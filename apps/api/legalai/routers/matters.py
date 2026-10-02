import uuid
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from ..audit import audit
from ..config import get_settings
from ..db import get_db
from ..models import AuditEvent, FallbackMode, Matter, MatterMember, PrivacyMode, User
from ..privacy import PrivacyViolation, validate_matter_settings
from ..security import current_user, get_matter_access

router = APIRouter(prefix="/api/matters", tags=["matters"])


class MatterCreate(BaseModel):
    name: str = Field(min_length=1, max_length=300)
    description: str = ""
    jurisdiction: str = ""
    relevant_date: date | None = None
    privacy_mode: PrivacyMode | None = None
    external_embedding_enabled: bool = False
    llm_fallback_mode: FallbackMode = FallbackMode.disabled


class MatterPatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=300)
    description: str | None = None
    jurisdiction: str | None = None
    relevant_date: date | None = None
    status: str | None = None
    privacy_mode: PrivacyMode | None = None
    external_embedding_enabled: bool | None = None
    llm_fallback_mode: FallbackMode | None = None


def matter_out(m: Matter, role: str) -> dict:
    return {"id": str(m.id), "name": m.name, "description": m.description, "jurisdiction": m.jurisdiction,
            "relevant_date": m.relevant_date.isoformat() if m.relevant_date else None, "status": m.status,
            "privacy_mode": m.privacy_mode, "external_embedding_enabled": m.external_embedding_enabled,
            "llm_fallback_mode": m.llm_fallback_mode, "my_role": role, "created_at": m.created_at.isoformat()}


@router.post("", status_code=201)
def create_matter(body: MatterCreate, user: User = Depends(current_user), db: DbSession = Depends(get_db)):
    mode = (body.privacy_mode or PrivacyMode(get_settings().default_privacy_mode)).value
    try:
        validate_matter_settings(mode, body.llm_fallback_mode.value, body.external_embedding_enabled)
    except PrivacyViolation as e:
        raise HTTPException(422, str(e))
    m = Matter(name=body.name, description=body.description, jurisdiction=body.jurisdiction,
               relevant_date=body.relevant_date, privacy_mode=mode,
               external_embedding_enabled=body.external_embedding_enabled,
               llm_fallback_mode=body.llm_fallback_mode.value)
    db.add(m)
    db.flush()
    db.add(MatterMember(matter_id=m.id, user_id=user.id, role="owner"))
    audit(db, "matter.created", user_id=user.id, matter_id=m.id, object_type="matter", object_id=m.id,
          privacy_mode=mode)
    db.commit()
    return matter_out(m, "owner")


@router.get("")
def list_matters(user: User = Depends(current_user), db: DbSession = Depends(get_db)):
    rows = db.execute(select(Matter, MatterMember.role).join(MatterMember, MatterMember.matter_id == Matter.id)
                      .where(MatterMember.user_id == user.id, Matter.deleted_at.is_(None))
                      .order_by(Matter.created_at.desc())).all()
    return [matter_out(m, r) for m, r in rows]


@router.get("/{matter_id}")
def get_matter(matter_id: uuid.UUID, user: User = Depends(current_user), db: DbSession = Depends(get_db)):
    m, role = get_matter_access(db, user, matter_id)
    return matter_out(m, role)


@router.patch("/{matter_id}")
def patch_matter(matter_id: uuid.UUID, body: MatterPatch, user: User = Depends(current_user),
                 db: DbSession = Depends(get_db)):
    m, role = get_matter_access(db, user, matter_id, "owner")
    changes = body.model_dump(exclude_unset=True)
    mode = (changes.get("privacy_mode") or PrivacyMode(m.privacy_mode)).value
    fb = (changes.get("llm_fallback_mode") or FallbackMode(m.llm_fallback_mode)).value
    emb = changes.get("external_embedding_enabled", m.external_embedding_enabled)
    # Tightening to local_only automatically clears the external toggles instead of rejecting the request.
    if mode == PrivacyMode.local_only.value and "privacy_mode" in changes:
        fb, emb = FallbackMode.disabled.value, False
    try:
        validate_matter_settings(mode, fb, emb)
    except PrivacyViolation as e:
        raise HTTPException(422, str(e))
    for k, v in changes.items():
        if k in ("privacy_mode", "llm_fallback_mode"):
            v = v.value
        if k not in ("privacy_mode", "llm_fallback_mode", "external_embedding_enabled"):
            setattr(m, k, v)
    m.privacy_mode, m.llm_fallback_mode, m.external_embedding_enabled = mode, fb, emb
    audit(db, "matter.updated", user_id=user.id, matter_id=m.id, object_type="matter", object_id=m.id,
          fields=sorted(changes))
    db.commit()
    return matter_out(m, role)


@router.get("/{matter_id}/audit")
def matter_audit(matter_id: uuid.UUID, limit: int = 100, user: User = Depends(current_user),
                 db: DbSession = Depends(get_db)):
    get_matter_access(db, user, matter_id)
    rows = db.scalars(select(AuditEvent).where(AuditEvent.matter_id == matter_id)
                      .order_by(AuditEvent.created_at.desc()).limit(min(limit, 500))).all()
    return [{"id": str(e.id), "at": e.created_at.isoformat(), "user_id": str(e.user_id) if e.user_id else None,
             "action": e.action, "object_type": e.object_type, "object_id": e.object_id, "detail": e.detail}
            for e in rows]
