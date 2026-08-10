# Database Migrations Guide

## Overview

This project uses **Alembic** to manage database schema migrations. The SQLAlchemy models in `app/models/models.py` are the source of truth, and Alembic generates migrations to keep PostgreSQL in sync.

## Quick Reference

```bash
# Check if migrations are needed (run in CI)
make migrate-check

# Create a new migration after changing a model
make migrate-new MSG="add avatar to users"

# Apply pending migrations
make migrate-up

# See what revision the database is at
make migrate-current

# See full history
make migrate-history

# Rollback last migration
make migrate-down REVISION=<revision_id>

# Rollback all the way
make migrate-down REVISION=base
```

## How It Works

1. You edit a model in `app/models/models.py`
2. Run `make migrate-new MSG="description"`
3. Alembic compares your models against the live database
4. A new file appears in `alembic/versions/` with the SQL to apply
5. Review the generated migration
6. Run `make migrate-up` to apply it

## Adding a New Table

```python
# 1. Add the model to app/models/models.py

class MyNewTable(Base):
    __tablename__ = "my_new_table"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    name = Column(String, nullable=False)

# 2. Import it in app/models/__init__.py

from .models import MyNewTable

# 3. Generate the migration

make migrate-new MSG="add my_new_table"

# 4. Review and apply

make migrate-up
```

## Adding a Column

```python
# 1. Add the column to the model

class User(Base):
    avatar_url = Column(String, nullable=True)  # nullable for existing rows

# 2. Generate migration (no manual steps needed)

make migrate-new MSG="add avatar_url to users"

# 3. Apply

make migrate-up
```

## Important Rules

### Do NOT
- Edit migration files after they've been applied
- Use `alembic stamp` unless you know exactly why
- Deploy code with model changes without running migrations first
- Modify the database directly in production

### Do
- Always generate migrations with `--autogenerate`
- Review generated migrations before applying
- Test migrations on a copy of production data
- Run `make migrate-check` in CI

## CI Integration

Add this to your CI pipeline to catch migration drift:

```yaml
# GitHub Actions example
- name: Check for migration drift
  run: |
    cd backend
    python check_migrations.py --diff
```

The script exits with code 1 if:
- There are pending migrations that haven't been applied
- The models have drifted from the database schema

## Common Issues

### " column X does not exist"
The model expects a column that doesn't exist in the database.
**Fix:** Create a migration: `make migrate-new MSG="add missing column"`

### "too many values to unpack"
A function's return type changed but callers weren't updated.
**Fix:** Update all callers to match the new return type.

### "table already exists"
You're trying to create a table that already exists.
**Fix:** Use `alembic stamp head` to mark the migration as applied without running it.

## Migration File Naming

Migration files follow the pattern:
```
alembic/versions/<revision>_<description>.py
```

The revision ID is auto-generated. The description should be kebab-case.

## Rolling Back

```bash
# See the full history to find the revision you want
make migrate-history

# Rollback to a specific revision
make migrate-down REVISION=3f9c1a2b7d04

# Rollback everything
make migrate-down REVISION=base
```

## Testing Migrations

Always test migrations against a database that mirrors production:

```bash
# Create a test database
createdb chatbot_test

# Set the test database URL
export DATABASE_URL=postgresql://...chatbot_test

# Apply all migrations
make migrate-up

# Verify
make migrate-check
```
