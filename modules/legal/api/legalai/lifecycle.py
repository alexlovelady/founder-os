"""Account lifecycle helpers used by the private internal endpoints: revoking sessions and deleting an account.

Account deletion semantics (see docs/ACCOUNTS.md):
  * All sessions are revoked, the account is deactivated (is_active=false, deleted_at set), the email becomes `deleted-<uuid>@invalid`,
    the display name is replaced, the password hash is replaced by a hash of a random secret, MFA secret and recovery codes are deleted.
  * Matters the user SOLELY owns (no other live member) are hard purged: stored files first, then every row (documents, versions,
    chunks, embeddings, jobs, research runs, drafts, reviews ... all cascade from the matter row). The user's personal playbooks go too.
  * Matters shared with other live users are left untouched (the user's membership is dropped unless they are the only owner).
  * Audit events stay (they refer to the pseudonymous user id; a failed-login entry holding the old email address is scrubbed).
  * Provider usage rows (token counts, no content) stay. Database and volume backups keep data until they rotate.
"""
import logging
import secrets
import shutil
import uuid
from datetime import datetime, timezone

from sqlalchemy import delete, func, select, text
from sqlalchemy.orm import Session as DbSession

from .audit import audit
from .models import Matter, MatterMember, MfaRecoveryCode, Playbook, Session, User
from .security import hash_password
from .storage import get_storage

log = logging.getLogger("legalai.lifecycle")


def revoke_sessions(db: DbSession, user_id: uuid.UUID) -> int:
    res = db.execute(delete(Session).where(Session.user_id == user_id))
    return res.rowcount or 0


def solely_owned_matter_ids(db: DbSession, user_id: uuid.UUID) -> list[uuid.UUID]:
    """Ordinary matters where the user is the owner and no other live (not deleted) user is a member."""
    mine = db.scalars(select(MatterMember.matter_id).join(Matter, Matter.id == MatterMember.matter_id)
                      .where(MatterMember.user_id == user_id, MatterMember.role == "owner", Matter.kind == "matter")).all()
    out: list[uuid.UUID] = []
    for mid in mine:
        others = db.scalar(select(func.count()).select_from(MatterMember).join(User, User.id == MatterMember.user_id)
                           .where(MatterMember.matter_id == mid, MatterMember.user_id != user_id, User.deleted_at.is_(None)))
        if not others:
            out.append(mid)
    return out


class PurgeFailed(Exception):
    pass


def purge_matters(db: DbSession, matter_ids: list[uuid.UUID]) -> dict:
    """Hard purge: files from storage first (nothing is deleted from the database if a file cannot be removed), then rows.
    Idempotent: missing files are fine and already-deleted matters are skipped."""
    store = get_storage()
    files = 0
    for mid in matter_ids:
        keys = db.execute(text("SELECT v.storage_key FROM document_versions v JOIN documents d ON d.id = v.document_id WHERE d.matter_id = :m"),
                          {"m": mid}).scalars().all()
        try:
            for k in keys:
                store.delete(k)
                files += 1
            # anything else stored under the matter's prefix (orphans of failed ingests); the path is validated to stay inside storage
            d = store._path(f"matters/{mid}")
            if d.exists():
                shutil.rmtree(d)
        except Exception as e:  # leave the rows so the purge can be retried; never log keys or names
            log.error("matter file purge failed: %s", type(e).__name__)
            raise PurgeFailed("Could not remove stored files") from e
    purged = 0
    for mid in matter_ids:
        m = db.get(Matter, mid)
        if m is not None:
            audit(db, "matter.purged", matter_id=mid, object_type="matter", object_id=mid)
            db.delete(m)  # ORM delete + DB cascade removes members, documents, versions, chunks, embeddings, jobs, runs, drafts, reviews ...
            purged += 1
    db.flush()
    return {"matters": purged, "files": files}


def is_last_admin(db: DbSession, user: User) -> bool:
    """True when this is an active admin and no other active admin exists (deleting it would leave nobody to administer)."""
    if user.role != "admin" or user.deleted_at:
        return False
    others = db.scalar(select(func.count()).select_from(User).where(User.role == "admin", User.id != user.id,
                                                                    User.is_active.is_(True), User.deleted_at.is_(None)))
    return not others


def delete_account(db: DbSession, user: User) -> dict:
    """Idempotent: running it again on a deleted user only retries the purge of anything solely owned."""
    first = user.deleted_at is None
    if first and is_last_admin(db, user):
        raise ValueError("last_admin")
    old_email = user.email
    sessions = revoke_sessions(db, user.id)
    owned = solely_owned_matter_ids(db, user.id)
    if first:
        user.email = f"deleted-{uuid.uuid4()}@invalid"
        user.display_name = "Deleted user"
        user.password_hash = hash_password(secrets.token_urlsafe(32))
        user.is_active = False
        user.deleted_at = datetime.now(timezone.utc)
        user.mfa_enabled, user.mfa_secret_enc, user.mfa_last_step = False, None, None
        db.execute(delete(MfaRecoveryCode).where(MfaRecoveryCode.user_id == user.id))
        db.execute(delete(Playbook).where(Playbook.owner_id == user.id))
        # an attempted-login audit row can carry the address in clear text: scrub it
        db.execute(text("UPDATE audit_events SET detail = detail - 'detail_email' WHERE detail ->> 'detail_email' = :e"), {"e": old_email})
        db.flush()
    purged = purge_matters(db, owned)
    # leave shared matters: drop the membership unless this user is the only owner there
    shared = db.scalars(select(MatterMember).where(MatterMember.user_id == user.id)).all()
    for mem in shared:
        if mem.role != "owner":
            db.delete(mem)
        else:
            other_owner = db.scalar(select(func.count()).select_from(MatterMember).where(
                MatterMember.matter_id == mem.matter_id, MatterMember.role == "owner", MatterMember.user_id != user.id))
            if other_owner:
                db.delete(mem)
    if first:
        audit(db, "auth.user_deleted_internal", user_id=user.id, object_type="user", object_id=user.id,
              sessions_revoked=sessions, matters_purged=purged["matters"], files_removed=purged["files"])
    return {"deleted": True, "matters_purged": purged["matters"], "files_removed": purged["files"], "sessions_revoked": sessions}
