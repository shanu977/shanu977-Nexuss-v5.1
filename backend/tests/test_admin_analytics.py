"""Admin Analytics API: SQL-aggregated summary + AI usage from real data."""

from datetime import datetime, timedelta, timezone

from app.models import UsageRecord, User
from app.models.models import utc_now_ms
from tests.admin_helpers import make_admin, provision_user
from tests.conftest import auth_headers
from tests.conftest_helpers import TestingSessionLocal

EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


def _ms_for_day(days):
    return int((EPOCH + timedelta(days=days)).timestamp() * 1000)


def _seed_usage(user_id="seed-user", provider="groq", model="m", status="success",
                input_tokens=0, output_tokens=0, total_tokens=0, created_at=None,
                request_type="chat", http_status=None, error_category=None):
    db = TestingSessionLocal()
    try:
        rec = UsageRecord(
            user_id=user_id,
            provider=provider,
            model=model,
            request_type=request_type,
            status=status,
            http_status=http_status,
            error_category=error_category,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            total_tokens=total_tokens,
            created_at=created_at or utc_now_ms(),
        )
        db.add(rec)
        db.commit()
        return rec.id
    finally:
        db.close()


def _seed_user(user_id, email):
    db = TestingSessionLocal()
    try:
        db.add(User(id=user_id, email=email, name="Seed"))
        db.commit()
    finally:
        db.close()


def test_summary_requires_auth(client):
    assert client.get("/admin/analytics/summary").status_code == 401


def test_summary_rejects_normal_user(client):
    headers = auth_headers(client)
    provision_user(client, headers)
    assert client.get("/admin/analytics/summary", headers=headers).status_code == 403


def test_summary_aggregates(client):
    admin_headers = make_admin(client, auth_headers(client))
    _seed_usage(user_id="u1", status="success", input_tokens=10, output_tokens=5, total_tokens=15)
    _seed_usage(user_id="u1", status="success", input_tokens=20, output_tokens=10, total_tokens=30)
    _seed_usage(user_id="u2", status="failed", error_category="rate_limit")
    _seed_user("u1", "u1@example.com")
    _seed_user("u2", "u2@example.com")

    res = client.get("/admin/analytics/summary", headers=admin_headers)
    assert res.status_code == 200
    totals = res.json()["totals"]
    assert totals["total_requests"] == 3
    assert totals["successful_requests"] == 2
    assert totals["failed_requests"] == 1
    assert totals["input_tokens"] == 30
    assert totals["output_tokens"] == 15
    assert totals["total_tokens"] == 45
    assert totals["active_users"] == 2
    assert totals["total_users"] >= 3
    assert totals["requests_today"] == 3


def test_summary_date_range(client):
    admin_headers = make_admin(client, auth_headers(client))
    _seed_usage(created_at=_ms_for_day(100))
    _seed_usage(created_at=_ms_for_day(110))
    _seed_usage(created_at=_ms_for_day(120))

    res = client.get(
        "/admin/analytics/summary",
        headers=admin_headers,
        params={"from_ms": _ms_for_day(105), "to_ms": _ms_for_day(115)},
    )
    assert res.json()["totals"]["total_requests"] == 1

    bad = client.get(
        "/admin/analytics/summary",
        headers=admin_headers,
        params={"from_ms": _ms_for_day(120), "to_ms": _ms_for_day(105)},
    )
    assert bad.status_code == 400


def test_ai_usage_daily_series(client):
    admin_headers = make_admin(client, auth_headers(client))
    _seed_usage(created_at=_ms_for_day(100), total_tokens=15)
    _seed_usage(created_at=_ms_for_day(100), status="failed", error_category="network")
    _seed_usage(created_at=_ms_for_day(101), total_tokens=7)

    res = client.get("/admin/analytics/ai-usage", headers=admin_headers)
    assert res.status_code == 200
    body = res.json()
    series = body["series"]
    assert len(series) == 2
    assert series[0]["date"] == "1970-04-11"  # day 100
    assert series[0]["requests"] == 2
    assert series[0]["successful"] == 1
    assert series[0]["failed"] == 1
    assert series[0]["total_tokens"] == 15
    assert series[1]["requests"] == 1
    assert body["totals"]["total_requests"] == 3


def test_ai_usage_provider_and_model_filter(client):
    admin_headers = make_admin(client, auth_headers(client))
    _seed_usage(provider="groq", model="m1", total_tokens=5)
    _seed_usage(provider="gemini", model="m2", total_tokens=9)
    _seed_usage(provider="groq", model="m3", status="failed")

    res = client.get(
        "/admin/analytics/ai-usage",
        headers=admin_headers,
        params={"provider": "groq", "model": "m1"},
    )
    body = res.json()
    assert body["totals"]["total_requests"] == 1
    assert body["totals"]["total_tokens"] == 5
    assert body["filters"]["provider"] == "groq"


def test_ai_usage_distributions(client):
    admin_headers = make_admin(client, auth_headers(client))
    _seed_usage(provider="groq", status="success", total_tokens=15, request_type="chat")
    _seed_usage(provider="groq", status="failed", total_tokens=0, request_type="chat")
    _seed_usage(provider="gemini", status="success", total_tokens=7, request_type="screen_share")

    res = client.get("/admin/analytics/ai-usage", headers=admin_headers)
    body = res.json()

    by_provider = {b["key"]: b for b in body["by_provider"]}
    assert by_provider["groq"]["requests"] == 2
    assert by_provider["groq"]["successful"] == 1
    assert by_provider["groq"]["failed"] == 1
    assert by_provider["gemini"]["requests"] == 1

    by_status = {b["key"]: b for b in body["by_status"]}
    assert by_status["success"]["requests"] == 2
    assert by_status["failed"]["requests"] == 1

    by_type = {b["key"]: b for b in body["by_request_type"]}
    assert by_type["chat"]["requests"] == 2
    assert by_type["screen_share"]["requests"] == 1


def test_ai_usage_requires_admin(client):
    headers = auth_headers(client)
    provision_user(client, headers)
    assert client.get("/admin/analytics/ai-usage", headers=headers).status_code == 403
