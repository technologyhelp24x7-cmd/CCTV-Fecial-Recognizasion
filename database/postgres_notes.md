# Database Architecture & PostgreSQL Migration Path

## Stage 1 Local Deployment (SQLite)

LumaFlux Intelligence uses SQLite (`database/schema.sql`) in WAL mode (`PRAGMA journal_mode = WAL;`) with foreign key enforcement (`PRAGMA foreign_keys = ON;`) for zero-configuration local desktop storage.

## Future Stage PostgreSQL Compatibility

All tables, column types, and repository queries follow ANSI SQL standards to make PostgreSQL migration straightforward:

1. **Primary Keys**: `TEXT` UUID strings are used instead of SQLite-only `INTEGER PRIMARY KEY AUTOINCREMENT`, mapping directly to `UUID` or `VARCHAR(64)` in PostgreSQL.
2. **Timestamps**: ISO-8601 UTC strings (`TEXT`) map directly to `TIMESTAMPTZ` in PostgreSQL.
3. **Booleans**: `INTEGER CHECK (enabled IN (0, 1))` can be replaced with native `BOOLEAN` via SQLAlchemy/Alembic migrations.
4. **Connection Layer**: `backend/app/db/database.py` abstracts DSN resolution (`LUMAFLUX_DATABASE_URL`) so swapping `sqlite:///...` to `postgresql+psycopg://...` requires zero UI or domain changes.
