# IMMEDIATE ACTION REQUIRED - PRODUCTION DATABASE MIGRATION

## THE ISSUE
- POST /chat returns 500
- Error: `psycopg2.errors.UndefinedColumn: column users.role does not exist`
- Root cause: Alembic migrations have not been applied to production PostgreSQL

## THE PROOF
```
SELECT users.id, ..., users.role, users.status FROM users
                           ↑ column doesn't exist
                                      ↑ column doesn't exist
```

## THE FIX
**Run these 8 commands in Railway production (copy-paste in order):**

```bash
railway shell
cd backend
alembic current
alembic upgrade head
alembic current
psql -c "\d users" | grep -E "role|status"
exit
railway redeploy
```

## EXPECTED RESULTS

### After Step "alembic upgrade head":
```
INFO  [alembic.runtime.migration] Running upgrade ... -> e1f2a3b4c5d6, Add role column...
INFO  [alembic.runtime.migration] Running upgrade ... -> f4b5c6d7e8f9, Add admin foundation...
```

### After Step "alembic current":
```
f4b5c6d7e8f9
```

### After Step "psql ... grep":
```
role    | character varying | not null default 'user'::character varying
status  | character varying | not null default 'active'::character varying
```

### After Step "railway redeploy" completes:
```
railway logs | head -20
# Should show:
# INFO: Backend started
# INFO: Application startup complete.
# NO warnings about missing columns
```

## THEN TEST

```bash
curl https://shanu977-nexuss-v51-production.up.railway.app/health
# Expected: 200 OK

# Browser: Open https://www.nexuss.in and send a message
# Expected: Message appears, no errors
```

## IF ANY STEP FAILS

**Stop immediately and report:**
1. Which command failed
2. The exact error message
3. Output of: `railway run alembic current`
4. Output of: `railway logs` (last 50 lines)

---

## CRITICAL: DO NOT SKIP STEPS

The migration MUST be applied to the production PostgreSQL database. There is no workaround.

Once all commands complete successfully, test from browser and report:

```
Migration status: DONE / FAILED
alembic current: [output]
users.role exists: YES / NO
users.status exists: YES / NO
POST /chat works: YES / NO
Browser chat works: YES / NO
```
