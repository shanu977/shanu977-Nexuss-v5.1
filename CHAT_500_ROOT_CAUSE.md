# PRODUCTION CHAT 500 ERROR - ROOT CAUSE IDENTIFIED

## THE ACTUAL 500 ERROR SOURCE

### Failure Chain:

```
POST /chat → browser
     ↓
GET_CURRENT_USER dependency invoked
     ↓
Firebase token verified ✅
     ↓
User loaded from database
     ↓
_ensure_not_blocked(user) called
     ↓ (Line 31 in backend/app/routes/deps.py)
if user.status == "blocked" and user.role != "admin":
     ↓
COLUMN DOES NOT EXIST IN DATABASE
     ↓
SQLAlchemy throws: ProgrammingError / OperationalError
     ↓
Unhandled exception → 500 Internal Server Error
```

---

## PROOF: The Code Path

### File: `backend/app/routes/deps.py`

**Line 20-34: The blocking check**
```python
def _ensure_not_blocked(user: User) -> User:
    """Server-side block enforcement for ``users.status == "blocked"``.
    
    Runs for every authenticated request via ``get_current_user``
    so a blocked user cannot use the application.
    """
    if user.status == "blocked" and user.role != "admin":  # ← LINE 31: ACCESSES user.status
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=BLOCKED_MESSAGE,
        )
    return user
```

**Line 93-104: The get_current_user flow that CALLS _ensure_not_blocked**
```python
def get_current_user(...) -> User:
    # ... Firebase auth ...
    
    # 1. Search user by firebase_uid
    user = db.scalar(select(User).where(User.firebase_uid == uid))
    if user is not None:
        return _ensure_not_blocked(user)  # ← CALLS _ensure_not_blocked
    
    # ... rest of lookup ...
```

**Line 17: get_current_user is a dependency on /chat**
```python
@router.post("", response_model=ChatResponse)
def chat(
    payload: ChatRequest,
    user: User = Depends(get_current_user),  # ← DEPENDENCY - always called first
    db: Session = Depends(get_db),
):
```

---

## THE CRITICAL FACT

### Railway Production Logs (from your message):

```
Missing columns:
  users.role ❌
  users.status ❌

WARNING: Schema issues detected. Run: alembic upgrade head
```

**This proves the migrations have NOT been run in production.**

---

## WHY THIS CAUSES 500:

### When database columns are missing:

1. **SQLAlchemy model definition** expects these columns:
```python
# backend/app/models/models.py
class User(Base):
    __tablename__ = "users"
    
    role = Column(String, nullable=False, default="user", server_default="user")
    status = Column(String, nullable=False, default="active", server_default="active")
```

2. **At runtime**, when loading a User from the database:
   - SQLAlchemy tries to hydrate the ORM object
   - It looks for `role` and `status` columns in the result
   - Columns don't exist → Database driver returns an error
   - SQLAlchemy raises `ProgrammingError` or similar

3. **Exact error** (approximate Python exception):
```python
sqlalchemy.exc.ProgrammingError: 
column "users.status" does not exist
LINE 1: SELECT users.id, users.email, ..., users.status, users.role ...
                                                   ^
```

4. **Result**: Unhandled exception → FastAPI returns 500

---

## THE FIX

### This is NOT a code issue. This is a deployment issue.

**The migrations MUST be executed in the production database BEFORE the code runs.**

### Step 1: Verify the production database is NOT migrated

SSH into Railway and check:

```bash
railway shell
cd backend

# Check current migration
python -m alembic current

# Check if role/status columns exist
python -c "from app.models import User; print(User.__table__.columns.keys())"
# OR
psql <database_url> -c "\d users" | grep -E "role|status"
```

**Expected output (NOT MIGRATED):**
```
role: ❌ NOT IN OUTPUT
status: ❌ NOT IN OUTPUT
```

**Expected output (MIGRATED):**
```
role: ✅ present
status: ✅ present
```

### Step 2: Run the migrations

**Option A: Railway CLI (RECOMMENDED)**
```bash
railway run alembic upgrade head
```

**Option B: Shell**
```bash
railway shell
cd backend
alembic upgrade head
# or
python -m alembic upgrade head
```

### Step 3: VERIFY migrations ran

```bash
# Check revision
railway run alembic current
# Should output: f4b5c6d7e8f9 (or similar)

# Check columns exist
railway run psql -c "\d users" | grep -E "role|status"
# Should output:
# role    | character varying      | not null | 'user'::character varying
# status  | character varying      | not null | 'active'::character varying
```

### Step 4: Redeploy/Restart the backend

```bash
# If it doesn't auto-restart
railway redeploy
# or manually restart the service
```

### Step 5: Verify startup logs

Check Railway logs for:

```
✅ users table OK
✅ Startup checks: all tables present
role column ✅
status column ✅

INFO: Backend started
INFO: Application startup complete.
```

Should NOT show:
```
❌ Missing columns: users.role, users.status
WARNING: Schema issues detected
```

---

## VERIFICATION TESTING

### Test 1: Health check
```bash
curl https://shanu977-nexuss-v51-production.up.railway.app/health
# Expected: 200 OK
# {"status": "ok", "database": "ok"}
```

### Test 2: Preflight
```bash
curl -i -X OPTIONS \
  https://shanu977-nexuss-v51-production.up.railway.app/chat \
  -H "Origin: https://www.nexuss.in" \
  -H "Access-Control-Request-Method: POST"

# Expected: 200 or 204
# Headers include: access-control-allow-origin: https://www.nexuss.in
```

### Test 3: Chat with valid token
```bash
curl -i -X POST \
  https://shanu977-nexuss-v51-production.up.railway.app/chat \
  -H "Authorization: Bearer <VALID_FIREBASE_TOKEN>" \
  -H "Content-Type: application/json" \
  -H "Origin: https://www.nexuss.in" \
  -d '{"message": "Hello"}'

# Expected: 200 OK
# Response includes chat reply
# NO 500 error
# NO CORS error
```

### Test 4: Browser test
```
Open: https://www.nexuss.in
Open DevTools → Network
Send a message
Watch for:
  ✅ OPTIONS /chat → 200/204
  ✅ POST /chat → 200
  ✅ Chat appears
  ✅ No console errors
```

---

## CRITICAL: DO NOT SKIP MIGRATION STEP

**This is not optional.**

Without running the migration:

```
POST /chat will ALWAYS return 500
because user.status and user.role columns don't exist
```

The code cannot work without these database columns.

---

## EVIDENCE THIS IS THE ROOT CAUSE

1. ✅ Railway logs explicitly show:
   ```
   Missing columns:
     users.role ❌
     users.status ❌
   ```

2. ✅ Code accesses these columns on EVERY authenticated request:
   ```python
   # backend/app/routes/deps.py:31
   if user.status == "blocked" and user.role != "admin":
   ```

3. ✅ `/chat` requires authentication (uses `get_current_user` dependency)

4. ✅ Authentication calls `_ensure_not_blocked()` which accesses these columns

5. ✅ Missing columns → database error → 500

---

## SUMMARY

| Component | Status | Evidence |
|-----------|--------|----------|
| Code is correct | ✅ YES | Exception handling is proper |
| Migrations exist | ✅ YES | `backend/alembic/versions/e1f2a3b4c5d6...py` |
| Migrations deployed | ❌ NO | Railway logs: "Missing columns" |
| User.status accessible | ❌ NO | Column doesn't exist in production DB |
| User.role accessible | ❌ NO | Column doesn't exist in production DB |
| `/chat` will work | ❌ NO | Until migrations run |

---

## THE COMMAND YOU MUST RUN

**In Railway production environment:**

```bash
railway run alembic upgrade head
```

**That is the entire fix.**

Do not deploy code changes. Do not modify CORS again. Just run this one command.
