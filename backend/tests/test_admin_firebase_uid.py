"""Admin authorization is bound to the verified Firebase UID and DB state."""

from app.models import User
from app.services import firebase_service
from tests.conftest_helpers import TestingSessionLocal


def _add_user(*, uid: str, email: str, role: str = "user", status: str = "active", name: str = "Stored Name"):
    db = TestingSessionLocal()
    try:
        db.add(
            User(
                id=f"db-{uid}",
                firebase_uid=uid,
                email=email,
                name=name,
                role=role,
                status=status,
            )
        )
        db.commit()
    finally:
        db.close()


def _verified_headers(monkeypatch, *, uid: str, email: str, name: str = "Firebase Name"):
    monkeypatch.setattr(
        firebase_service,
        "verify_id_token",
        lambda token: {"uid": uid, "email": email, "name": name},
    )
    return {"Authorization": "Bearer verified-firebase-token"}


def test_active_admin_with_matching_verified_uid_is_allowed(client, monkeypatch):
    _add_user(uid="admin-uid", email="admin@example.com", role="admin")
    response = client.get(
        "/admin/health",
        headers=_verified_headers(monkeypatch, uid="admin-uid", email="admin@example.com"),
    )
    assert response.status_code == 200


def test_uid_mismatch_does_not_bind_or_authorize_existing_email(client, monkeypatch):
    _add_user(uid="stored-admin-uid", email="admin@example.com", role="admin")
    response = client.get(
        "/admin/health",
        headers=_verified_headers(monkeypatch, uid="different-uid", email="admin@example.com"),
    )
    assert response.status_code == 403


def test_matching_uid_for_non_admin_is_rejected(client, monkeypatch):
    _add_user(uid="member-uid", email="member@example.com", role="user")
    response = client.get(
        "/admin/health",
        headers=_verified_headers(monkeypatch, uid="member-uid", email="member@example.com"),
    )
    assert response.status_code == 403


def test_inactive_admin_is_rejected(client, monkeypatch):
    _add_user(uid="inactive-uid", email="inactive@example.com", role="admin", status="inactive")
    response = client.get(
        "/admin/health",
        headers=_verified_headers(monkeypatch, uid="inactive-uid", email="inactive@example.com"),
    )
    assert response.status_code == 403


def test_firebase_display_name_does_not_affect_admin_authorization(client, monkeypatch):
    _add_user(uid="admin-uid", email="admin@example.com", role="admin", name="Database Name")
    response = client.get(
        "/admin/health",
        headers=_verified_headers(
            monkeypatch,
            uid="admin-uid",
            email="admin@example.com",
            name="Changed Firebase Display Name",
        ),
    )
    assert response.status_code == 200


def test_client_role_status_and_name_values_cannot_grant_admin_access(client, monkeypatch):
    _add_user(uid="member-uid", email="member@example.com", role="user", status="active")
    response = client.get(
        "/admin/health?role=admin&status=active&name=shanmuk",
        headers=_verified_headers(monkeypatch, uid="member-uid", email="member@example.com"),
    )
    assert response.status_code == 403
