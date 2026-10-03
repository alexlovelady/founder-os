import uuid
from sqlalchemy.orm import Session as DbSession
from .models import AuditEvent


def audit(db: DbSession, action: str, *, user_id: uuid.UUID | None = None, matter_id: uuid.UUID | None = None,
          object_type: str = "", object_id: str | uuid.UUID = "", **detail) -> AuditEvent:
    """Append-only audit record. Never put raw document text or secrets in `detail`."""
    ev = AuditEvent(user_id=user_id, matter_id=matter_id, action=action, object_type=object_type,
                    object_id=str(object_id), detail=detail)
    db.add(ev)
    return ev
