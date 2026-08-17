# Production CORS Diagnostics - Complete Test Suite

## Test Commands to Run Against Production Backend

### Endpoint: https://shanu977-nexuss-v51-production.up.railway.app
### Frontend Origin: https://www.nexuss.in

---

## 1. Test /health (No Auth Required)

### OPTIONS /health
```bash
curl -i -X OPTIONS \
  -H "Origin: https://www.nexuss.in" \
  -H "Access-Control-Request-Method: GET" \
  https://shanu977-nexuss-v51-production.up.railway.app/health
```

Expected: 200 or 204 with CORS headers

### GET /health  
```bash
curl -i -H "Origin: https://www.nexuss.in" \
  https://shanu977-nexuss-v51-production.up.railway.app/health
```

Expected: 200 with CORS headers and {"status": "ok", "database": "ok"}

---

## 2. Test /settings (Requires Auth)

### OPTIONS /settings
```bash
curl -i -X OPTIONS \
  -H "Origin: https://www.nexuss.in" \
  -H "Access-Control-Request-Method: GET" \
  -H "Access-Control-Request-Headers: authorization,content-type" \
  https://shanu977-nexuss-v51-production.up.railway.app/settings
```

Expected: 200 or 204 with CORS headers (no auth required for preflight)

### GET /settings (with valid token)
```bash
curl -i -H "Origin: https://www.nexuss.in" \
  -H "Authorization: Bearer <FIREBASE_TOKEN>" \
  https://shanu977-nexuss-v51-production.up.railway.app/settings
```

Expected: 200 with CORS headers and settings JSON

### GET /settings (without token)
```bash
curl -i -H "Origin: https://www.nexuss.in" \
  https://shanu977-nexuss-v51-production.up.railway.app/settings
```

Expected: 401 with CORS headers and {"detail": "Missing or invalid Authorization header..."}

---

## 3. Test /chat (Requires Auth + Rate Limited)

### OPTIONS /chat
```bash
curl -i -X OPTIONS \
  -H "Origin: https://www.nexuss.in" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: authorization,content-type" \
  https://shanu977-nexuss-v51-production.up.railway.app/chat
```

Expected: 200 or 204 with CORS headers

### POST /chat (with valid token)
```bash
curl -i -X POST \
  -H "Origin: https://www.nexuss.in" \
  -H "Authorization: Bearer <FIREBASE_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"message":"hello"}' \
  https://shanu977-nexuss-v51-production.up.railway.app/chat
```

Expected: 200 with CORS headers and chat response

### POST /chat (without token)
```bash
curl -i -X POST \
  -H "Origin: https://www.nexuss.in" \
  -H "Content-Type: application/json" \
  -d '{"message":"hello"}' \
  https://shanu977-nexuss-v51-production.up.railway.app/chat
```

Expected: 401 with CORS headers and auth error message

---

## 4. Check Response Headers

For EVERY response above, verify:
- `access-control-allow-origin: https://www.nexuss.in` ✓
- `access-control-allow-credentials: true` ✓
- `access-control-allow-methods: *` (or specific methods) ✓
- `access-control-allow-headers: *` (or specific headers) ✓

If ANY response is missing these headers, that's the problem.

---

## 5. Check Railway Logs

While testing, watch Railway logs:
```bash
railway logs --follow
```

Look for:
- Line status (200, 204, 400, 401, 403, 429, 500, etc.)
- Error messages
- Database errors
- Authentication errors
- Rate limit triggers

---

## 6. Database Schema Check

From Railway:
```bash
railway shell
cd backend
psql -c "\d users" | grep -E "role|status"
```

Expected: 2 lines showing role and status columns

If empty: **Database migrations not applied** ← This is the cause of /chat and /settings 500 errors

---

## 7. Deployed Code Check

Verify rate_limit.py contains OPTIONS bypass:
```bash
railway shell
grep -A 3 "request.method == \"OPTIONS\"" backend/app/middleware/rate_limit.py
```

Expected: Found (4 lines showing the bypass)

---

## ISSUE SUMMARY TABLE

Fill in results:

| Endpoint | Method | Test | Status | CORS Headers | Root Cause |
|----------|--------|------|--------|--------------|-----------|
| /health | GET | No Auth | ? | PASS/FAIL | |
| /health | OPTIONS | Preflight | ? | PASS/FAIL | |
| /settings | OPTIONS | Preflight | ? | PASS/FAIL | |
| /settings | GET | No Token | ? | PASS/FAIL | |
| /settings | GET | With Token | ? | PASS/FAIL | |
| /chat | OPTIONS | Preflight | ? | PASS/FAIL | |
| /chat | POST | No Token | ? | PASS/FAIL | |
| /chat | POST | With Token | ? | PASS/FAIL | |

---

## LIKELY ROOT CAUSES

### 1. Database Migrations Not Applied
- Error: `UndefinedColumn: column users.role does not exist`
- Endpoints affected: /chat, /settings, and any endpoint that loads User model
- Fix: `railway shell` → `cd backend` → `alembic upgrade head`
- This is HIGH PROBABILITY given previous conversation

### 2. Global Error Handler Missing CORS Headers
- Error: 500 responses lack Access-Control-Allow-Origin header
- Cause: Custom exception handler returns response outside middleware chain
- Fix: Add global error handler that returns responses compatible with CORS
- This is MEDIUM PROBABILITY

### 3. CORSMiddleware Configuration Wrong
- Error: allow_origins doesn't include https://www.nexuss.in
- Check: `settings.cors_origins_list` contains the correct origin
- Fix: Update .env or environment variables
- This is LOW PROBABILITY (would have failed earlier)

### 4. OPTIONS Bypass Not Deployed
- Error: OPTIONS requests return 429 from rate limiter
- Cause: Production code doesn't have the OPTIONS bypass fix
- Fix: Deploy latest code with OPTIONS bypass
- This is LOW PROBABILITY (should be deployed)

### 5. RateLimitMiddleware Returning 429 Without CORS Headers
- Error: 429 responses lack Access-Control-Allow-Origin header
- Cause: Custom JSONResponse in middleware doesn't have CORS headers
- Fix: Ensure middleware responses are compatible with CORS
- This is MEDIUM PROBABILITY

---

## NEXT STEPS AFTER DIAGNOSIS

1. If database issue: Execute `alembic upgrade head`
2. If 500 errors: Add global exception handler with CORS headers
3. If 429 responses: Ensure middleware responses include CORS headers
4. If OPTIONS rejected: Verify OPTIONS bypass is deployed
5. If CORS config: Update environment variables

**DO NOT** guess - test first, diagnose second, fix third.
