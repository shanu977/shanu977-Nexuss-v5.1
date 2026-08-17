# PRODUCTION MIGRATION EXECUTION - WITH VERIFICATION

## SITUATION
- ✅ CORS preflight: Working (OPTIONS /chat → 200)
- ❌ POST /chat: Returns 500
- ❌ Root cause: `psycopg2.errors.UndefinedColumn: column users.role does not exist`
- ✅ Migrations exist: `e1f2a3b4c5d6_add_users_role.py` and `f4b5c6d7e8f9_add_admin_foundation_tables.py`
- ❌ Migrations not applied: Production PostgreSQL database lacks columns

## MIGRATION FILES VERIFIED

**Migration 1: e1f2a3b4c5d6_add_users_role.py**
- Creates: `users.role` column (String, non-null, default='user')

**Migration 2: f4b5c6d7e8f9_add_admin_foundation_tables.py**
- Creates: `users.status` column (String, non-null, default='active')
- Creates: `usage_records` table
- Creates: `feedback` table
- Creates: `app_settings` table
- Creates: `audit_log` table

Both migrations are syntactically correct and safe to apply.

---

## EXECUTION PLAN

### Step 1: Connect to Railway Production

```bash
railway shell
```

**Expected**: You should be inside the Railway production container.

### Step 2: Navigate to Backend

```bash
cd backend
```

**Expected**: You should be in `/app/backend` (or similar).

### Step 3: Check Current Alembic Revision

```bash
alembic current
```

**Expected output**: One of:
- Empty (no migrations applied)
- `d5e6f7a8b9c0` (email_otps migration applied, but not role/status)
- `e1f2a3b4c5d6` (role applied but not status/admin tables)

**If it shows `f4b5c6d7e8f9`**: Migrations are already applied (skip to Step 8)

### Step 4: Check Alembic History

```bash
alembic history
```

**Expected output**: Shows the migration chain including `e1f2a3b4c5d6` and `f4b5c6d7e8f9`

### Step 5: View Pending Migrations

```bash
alembic upgrade --sql head
```

**Expected output**: Shows the SQL that WILL be executed (does not execute it yet)

### Step 6: Apply Migrations (THE CRITICAL STEP)

```bash
alembic upgrade head
```

**Expected output**:
```
INFO  [alembic.runtime.migration] Running upgrade d5e6f7a8b9c0 -> e1f2a3b4c5d6, Add role column...
INFO  [alembic.runtime.migration] Running upgrade e1f2a3b4c5d6 -> f4b5c6d7e8f9, Add admin foundation...
```

**If output is**: `Target database is not up to date`
- Run: `alembic downgrade base` then `alembic upgrade head`

### Step 7: Verify Migration Applied

```bash
alembic current
```

**Expected output**: `f4b5c6d7e8f9` (the latest migration)

### Step 8: Verify Columns Exist in PostgreSQL

```bash
psql -c "\d users" | grep -E "role|status"
```

**Expected output** (2 lines):
```
 role    | character varying          | not null default 'user'::character varying
 status  | character varying          | not null default 'active'::character varying
```

**If no output or error**: Columns don't exist. STOP and investigate.

### Step 9: Verify All Expected Tables Exist

```bash
psql -c "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name;"
```

**Expected tables** (should include):
- users ✅
- conversations ✅
- messages ✅
- user_settings ✅
- user_api_keys ✅
- usage_records ✅ (new)
- feedback ✅ (new)
- app_settings ✅ (new)
- audit_log ✅ (new)
- email_otps ✅

### Step 10: Exit Railway Shell

```bash
exit
```

### Step 11: Redeploy Backend

```bash
railway redeploy
```

**Expected**: Backend container restarts and picks up the migrated database schema.

### Step 12: Monitor Startup Logs

```bash
railway logs --follow
```

**Expected output** (within 30 seconds):
```
INFO: Database health check:
✅ users table OK
✅ user_settings table OK
✅ conversations table OK
✅ messages table OK
✅ usage_records table OK
✅ feedback table OK
✅ app_settings table OK
✅ audit_log table OK
✅ email_otps table OK

INFO: Schema check complete. All tables present.
INFO: Backend started
INFO: Uvicorn running on http://0.0.0.0:8080
INFO: Application startup complete.
```

**NOT expected**:
```
❌ Missing columns: users.role, users.status
WARNING: Schema issues detected. Run: alembic upgrade head
```

---

## VERIFICATION TESTS

### Test 1: Health Endpoint

```bash
curl https://shanu977-nexuss-v51-production.up.railway.app/health
```

**Expected**:
```json
{"status": "ok", "database": "ok"}
```

**Status**: 200 OK

### Test 2: OPTIONS Preflight (Reconfirm)

```bash
curl -i -X OPTIONS \
  https://shanu977-nexuss-v51-production.up.railway.app/chat \
  -H "Origin: https://www.nexuss.in" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: authorization,content-type"
```

**Expected**:
```
HTTP/1.1 200 OK
access-control-allow-origin: https://www.nexuss.in
access-control-allow-methods: POST (or *)
access-control-allow-headers: authorization,content-type (or *)
```

### Test 3: POST /chat with Valid Firebase Token

Get a valid Firebase token from the frontend (open https://www.nexuss.in, get token from LocalStorage under `firebaseToken`), then:

```bash
curl -i -X POST \
  https://shanu977-nexuss-v51-production.up.railway.app/chat \
  -H "Authorization: Bearer <VALID_TOKEN>" \
  -H "Content-Type: application/json" \
  -H "Origin: https://www.nexuss.in" \
  -d '{"message": "Hello, can you say hello back?"}'
```

**Expected**:
```
HTTP/1.1 200 OK
access-control-allow-origin: https://www.nexuss.in
content-type: application/json

{"reply": "Hello! ...","conversation_id": "..."}
```

**NOT expected**:
```
500 Internal Server Error
psycopg2.errors.UndefinedColumn
column users.role does not exist
```

### Test 4: Browser Integration Test

```
1. Open https://www.nexuss.in
2. Clear browser cache (Ctrl+Shift+Delete / Cmd+Shift+Delete)
3. Hard refresh (Ctrl+Shift+R / Cmd+Shift+R)
4. Open DevTools → Network tab
5. Type a message and send
6. Verify:
   - OPTIONS /chat → 200 ✅
   - POST /chat → 200 ✅
   - Message appears ✅
   - No red errors ✅
   - No console errors ✅
```

---

## TROUBLESHOOTING

### Symptom: "alembic upgrade head" says "Target database is not up to date but has no down revision set"

**Action**:
```bash
alembic downgrade base
alembic upgrade head
alembic current
```

### Symptom: Migration runs but `alembic current` still shows old revision

**Action**:
```bash
# Check if migration actually ran
psql -c "SELECT version, is_current FROM alembic_version ORDER BY version DESC LIMIT 5;"

# Manually verify columns exist
psql -c "\d users" | grep -E "role|status"

# If columns exist but alembic version is wrong, check for inconsistency
alembic history --verbose
```

### Symptom: Columns don't exist even after migration ran

**Action** (CRITICAL):
```bash
# Stop the backend
railway stop

# Check if database URL is correct
echo $DATABASE_URL

# Verify you're connected to the right database
psql -c "SELECT current_database();"

# List all tables to verify it's the right database
psql -c "\dt"

# Try migration again
alembic upgrade head

# Restart
railway start
```

### Symptom: POST /chat returns 500 even after migration completes

**Action**:
```bash
# Get the new traceback from logs
railway logs | grep -A 10 "POST /chat\|Traceback\|Error"

# Do NOT reuse old traceback
# Report the NEW exception exactly
```

### Symptom: Cannot connect to psql from Railway shell

**Action**:
```bash
# Check database URL is available
env | grep -i database

# Try alternative connection
railway run psql -c "SELECT 1;"

# If that fails, database may be down
```

---

## FINAL VERIFICATION CHECKLIST

Before declaring success, verify ALL of these:

```
☐ alembic current shows: f4b5c6d7e8f9
☐ psql \d users shows: role column ✅
☐ psql \d users shows: status column ✅
☐ Startup logs show NO "Missing columns" warning
☐ Startup logs show NO "Schema issues detected"
☐ GET /health returns 200 OK
☐ OPTIONS /chat returns 200 or 204 + CORS headers
☐ POST /chat returns 200 (not 500) with valid token
☐ Browser https://www.nexuss.in can send chat message
☐ No new exceptions in Railway logs
```

**All 10 must be true to report success.**

---

## FINAL REPORT FORMAT

After completing all steps, provide:

```
Execution completed: [DATE/TIME]

CORS preflight: PASS/FAIL
  - OPTIONS /chat status: ___

Database migration: PASS/FAIL
  - alembic current: ___
  - users.role exists: PASS/FAIL
  - users.status exists: PASS/FAIL

Backend restart: PASS/FAIL
  - Startup log shows "Backend started": PASS/FAIL
  - NO "Missing columns" warning: PASS/FAIL

POST /chat endpoint: PASS/FAIL
  - Status code: ___
  - Response: [success/error/500]
  - Exception (if 500): [exact traceback or NONE]

Browser chat test: PASS/FAIL
  - Message sent: PASS/FAIL
  - Message received response: PASS/FAIL
  - No console errors: PASS/FAIL

OVERALL STATUS: WORKING / BLOCKED
  - If BLOCKED, exact issue: ___
```

---

## DO NOT

❌ Manually INSERT rows into alembic_version table  
❌ Skip the redeploy step  
❌ Ignore startup log warnings  
❌ Assume migration succeeded without checking `alembic current`  
❌ Test with invalid/expired Firebase tokens  
❌ Report success until browser test passes  

---

## EXECUTE NOW

Run these commands in sequence:

```bash
railway shell
cd backend
alembic current
alembic upgrade head
alembic current
psql -c "\d users" | grep -E "role|status"
exit
railway redeploy
railway logs
```

Then test from browser: https://www.nexuss.in

Report the results using the format above.
