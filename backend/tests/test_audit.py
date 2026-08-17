"""Audit trail: Admin mutations record audit_log entries with the correct
admin identity, action, target and details."""

import json

from app.models import AuditLog, Feedback, User
from tests.admin_helpers import get_user_id, make_admin, provision_user
from tests.conftest import auth_headers
from tests.conftest_helpers import TestingSessionLocal


def _audit_rows(action=None):
    db = TestingSessionLocal()
    try:
        q = db.query(AuditLog).order_by(AuditLog.created_at)
        if action is not None:
            q = q.filter(AuditLog.action == action)
        return q.all()
    finally:
        db.close()


def _seed_user(user_id, email):
    db = TestingSessionLocal()
    try:
        db.add(User(id=user_id, email=email, name="Seed"))
        db.commit()
    finally:
        db.close()


def _seed_feedback(user_id):
    db = TestingSessionLocal()
    try:
        fb = Feedback(user_id=user_id, rating=4, message="hi", status="new")
        db.add(fb)
        db.commit()
        return fb.id
    finally:
        db.close()


def test_role_change_records_audit(client):
    admin_headers = make_admin(client, auth_headers(client))
    admin_id = get_user_id("test@example.com")
    _seed_user("promote-me", "promote-me@example.com")

    client.patch("/admin/users/promote-me/role", headers=admin_headers, json={"role": "admin"})

    rows = _audit_rows("user.role.change")
    assert len(rows) == 1
    entry = rows[0]
    assert entry.admin_user_id == admin_id
    assert entry.target_type == "user"
    assert entry.target_id == "promote-me"
    assert entry.ip_address == "testclient"
    details = json.loads(entry.details)
    assert details == {"from": "user", "to": "admin"}


def test_block_records_audit(client):
    admin_headers = make_admin(client, auth_headers(client))
    _seed_user("block-me", "block-me@example.com")

    client.post("/admin/users/block-me/block", headers=admin_headers)

    rows = _audit_rows("user.block")
    assert len(rows) == 1
    assert rows[0].target_id == "block-me"
    assert json.loads(rows[0].details)["email"] == "block-me@example.com"


def test_settings_update_records_audit(client):
    admin_headers = make_admin(client, auth_headers(client))

    client.put(
        "/admin/settings",
        headers=admin_headers,
        json=[{"key": "feature:flag", "value": "true", "value_type": "boolean"}],
    )

    rows = _audit_rows("settings.update")
    assert len(rows) == 1
    assert rows[0].target_type == "app_settings"
    assert rows[0].target_id == "feature:flag"
    details = json.loads(rows[0].details)
    assert details["to"] == "true"


def test_feedback_status_change_records_audit(client):
    admin_headers = make_admin(client, auth_headers(client))
    _seed_user("feedback-user", "feedback-user@example.com")
    fb_id = _seed_feedback("feedback-user")

    client.patch(
        f"/admin/feedback/{fb_id}", headers=admin_headers, json={"status": "closed"}
    )

    rows = _audit_rows("feedback.status.change")
    assert len(rows) == 1
    assert rows[0].target_id == fb_id
    assert json.loads(rows[0].details) == {"from": "new", "to": "closed"}


def test_audit_identity_is_the_acting_admin(client):
    """The audit row must record who performed the action, not the target."""
    admin_headers = make_admin(client, auth_headers(client))
    admin_id = get_user_id("test@example.com")
    other_headers = {"Authorization": "Bearer test-mock-token-other"}
    provision_user(client, other_headers)
    other_id = get_user_id("test-mock-token-other@example.com")

    client.patch(f"/admin/users/{other_id}/role", headers=admin_headers, json={"role": "admin"})

    rows = _audit_rows("user.role.change")
    assert len(rows) == 1
    assert rows[0].admin_user_id == admin_id
    assert rows[0].target_id == other_id


def test_failed_mutation_records_no_audit(client):
    """A rejected mutation (e.g. blocking an admin) must not create an audit row."""
    admin_headers = make_admin(client, auth_headers(client))
    _seed_user("boss", "boss@example.com")
    db = TestingSessionLocal()
    try:
        boss = db.query(User).filter(User.id == "boss").one()
        boss.role = "admin"
        db.commit()
    finally:
        db.close()

    assert client.post("/admin/users/boss/block", headers=admin_headers).status_code == 400
    assert _audit_rows("user.block") == []
