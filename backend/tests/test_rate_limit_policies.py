"""Configured endpoint limits and Retry-After behavior."""

from app.models import User
from tests.conftest_helpers import TestingSessionLocal


def _make_admin_for_mock_token():
    db = TestingSessionLocal()
    try:
        db.add(
            User(
                id="test-uid-1",
                firebase_uid="test-uid-1",
                email="test@example.com",
                name="Test User",
                role="admin",
                status="active",
            )
        )
        db.commit()
    finally:
        db.close()


def _assert_limited(response):
    assert response.status_code == 429
    assert response.json() == {"detail": "Too many requests. Please try again later."}
    assert int(response.headers["retry-after"]) > 0


def test_otp_send_is_limited_to_five_requests_per_minute(client):
    for number in range(5):
        response = client.post("/auth/otp/send", json={"email": f"rate{number}@example.com"})
        assert response.status_code == 200
    _assert_limited(client.post("/auth/otp/send", json={"email": "blocked@example.com"}))


def test_user_status_is_limited_to_ten_requests_per_minute(client):
    for number in range(10):
        response = client.post("/auth/user-status", json={"email": f"rate{number}@example.com"})
        assert response.status_code == 200
    _assert_limited(client.post("/auth/user-status", json={"email": "blocked@example.com"}))


def test_admin_paths_are_limited_to_fifteen_requests_per_minute(client):
    _make_admin_for_mock_token()
    headers = {"Authorization": "Bearer test-mock-token"}
    for _ in range(15):
        assert client.get("/admin/health", headers=headers).status_code == 200
    _assert_limited(client.get("/admin/health", headers=headers))


def test_retry_after_is_the_remaining_sliding_window_time(client, monkeypatch):
    from app.middleware import rate_limit

    now = {"value": 1000.0}
    monkeypatch.setattr(rate_limit.time, "monotonic", lambda: now["value"])
    for number in range(5):
        assert client.post("/auth/otp/send", json={"email": f"time{number}@example.com"}).status_code == 200

    now["value"] = 1010.0
    response = client.post("/auth/otp/send", json={"email": "time-blocked@example.com"})
    _assert_limited(response)
    assert response.headers["retry-after"] == "50"


def test_retry_after_never_returns_zero_while_still_blocked(client, monkeypatch):
    from app.middleware import rate_limit

    now = {"value": 1000.0}
    monkeypatch.setattr(rate_limit.time, "monotonic", lambda: now["value"])
    for number in range(5):
        assert client.post("/auth/otp/send", json={"email": f"edge{number}@example.com"}).status_code == 200

    now["value"] = 1059.0
    response = client.post("/auth/otp/send", json={"email": "edge-blocked@example.com"})
    _assert_limited(response)
    assert response.headers["retry-after"] == "1"


def test_options_is_not_counted_and_cors_headers_survive_a_429(client):
    origin = "http://localhost:3000"
    for number in range(5):
        assert client.post("/auth/otp/send", json={"email": f"cors{number}@example.com"}).status_code == 200

    preflight = client.options(
        "/auth/otp/send",
        headers={"Origin": origin, "Access-Control-Request-Method": "POST"},
    )
    assert preflight.status_code == 200

    response = client.post(
        "/auth/otp/send",
        json={"email": "cors-blocked@example.com"},
        headers={"Origin": origin},
    )
    _assert_limited(response)
    assert response.headers["access-control-allow-origin"] == origin
