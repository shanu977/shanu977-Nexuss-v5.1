"""Admin authorization tests.

Proves the server-side admin role chain:

    Firebase token -> get_current_user -> get_current_admin -> /admin/health

- Unauthenticated requests are rejected (401).
- Authenticated normal users are rejected (403).
- Authenticated admins are allowed (200).
- Existing users keep their data and default to the "user" role.
- The admin role is read from the server-side user record, never from the client.
"""

from app.models import User
from tests.conftest import auth_headers
from tests.conftest_helpers import TestingSessionLocal

HEADERS_OTHER = {"Authorization": "Bearer test-mock-token-other"}


def _set_role(email: str, role: str) -> None:
    """Update a provisioned user's server-side role directly in the DB."""
    db = TestingSessionLocal()
    try:
        user = db.query(User).filter(User.email == email).first()
        assert user is not None, f"User {email} was not provisioned"
        user.role = role
        db.commit()
    finally:
        db.close()


def _provision_user(client, headers):
    """Any authenticated endpoint provisions the user on first request."""
    res = client.get("/settings", headers=headers)
    assert res.status_code == 200


def test_admin_health_requires_auth(client):
    assert client.get("/admin/health").status_code == 401


def test_admin_health_rejects_normal_user(client):
    headers = auth_headers(client)
    assert client.get("/admin/health", headers=headers).status_code == 403


def test_admin_health_allows_admin(client):
    headers = auth_headers(client)
    _provision_user(client, headers)
    _set_role("test@example.com", "admin")

    res = client.get("/admin/health", headers=headers)
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"
    assert body["admin"]["email"] == "test@example.com"
    assert body["admin"]["role"] == "admin"


def test_existing_normal_user_data_intact_and_role_defaults_to_user(client):
    headers = auth_headers(client)

    get = client.get("/settings", headers=headers)
    assert get.status_code == 200
    assert get.json()["theme"] == "light"

    # The existing user record is intact, with the default role.
    db = TestingSessionLocal()
    try:
        user = db.query(User).filter(User.email == "test@example.com").first()
        assert user is not None
        assert user.role == "user"
        assert user.email == "test@example.com"
        assert user.name == "Test User"
        assert user.provider == "firebase"
    finally:
        db.close()

    # A normal user still cannot reach the admin endpoint.
    assert client.get("/admin/health", headers=headers).status_code == 403


def test_admin_role_read_from_server_side_record(client):
    """Role must come from the DB record: promoting changes access, demoting revokes it."""
    headers = auth_headers(client)
    _provision_user(client, headers)

    assert client.get("/admin/health", headers=headers).status_code == 403

    _set_role("test@example.com", "admin")
    res = client.get("/admin/health", headers=headers)
    assert res.status_code == 200
    assert res.json()["admin"]["role"] == "admin"

    _set_role("test@example.com", "user")
    assert client.get("/admin/health", headers=headers).status_code == 403


def test_promoting_one_user_grants_admin_only_to_that_user(client):
    headers_a = auth_headers(client)
    headers_b = HEADERS_OTHER
    _provision_user(client, headers_a)
    _provision_user(client, headers_b)

    _set_role("test@example.com", "admin")

    assert client.get("/admin/health", headers=headers_a).status_code == 200
    assert client.get("/admin/health", headers=headers_b).status_code == 403
