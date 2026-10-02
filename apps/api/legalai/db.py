from contextlib import contextmanager
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, DeclarativeBase
from .config import get_settings

_engine = None
_Session = None


def engine():
    global _engine, _Session
    if _engine is None:
        _engine = create_engine(get_settings().database_url, pool_pre_ping=True)
        _Session = sessionmaker(_engine, expire_on_commit=False)
    return _engine


def reset_engine():
    global _engine, _Session
    if _engine is not None:
        _engine.dispose()
    _engine = _Session = None


class Base(DeclarativeBase):
    pass


def get_db():
    engine()
    with _Session() as s:
        yield s


@contextmanager
def session_scope():
    engine()
    with _Session() as s:
        try:
            yield s
            s.commit()
        except Exception:
            s.rollback()
            raise
