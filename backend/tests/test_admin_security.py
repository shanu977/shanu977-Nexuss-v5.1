"""Admin Security audit endpoint: pagination, filters, ordering, and that only
the acting admin can read it. Uses real audit_log rows written by the
mutating admin APIs."""

import json

from app.models import AuditLog, User
from tests.admin_helpers import get_user_id, make_admin
from tests.conftest import auth_headers
from tests.conftest_helpers import TestingSessionLocal


def _seed_user(user_id, email):
    db = TestingSessionLocal()
    try:
        db.add(User(id=user_id, email=email, name="Seed User"))
        db.commit()
    finally:
        db.close()


def _seed_audit_rows(admin_id, count):
    db = TestingSessionLocal()
    try:
        for i in range(count):
            db.add(
                AuditLog(
                    admin_user_id=admin_id,
                    action=f"test.action.{i}",
                    target_type="user",
                    target_id=f"target-{i}",
                    details=json.dumps({"seq": i}),
                    ip_address=f"10.0.0.{i}",
                    created_at=1_000_000 + i,
                )
            )
        db.commit()
    finally:
        db.close()


def _admin_email(client, headers):
    return "test@example.com"


def test_audit_requires_admin(client):
    res = client.get("/admin/security/audit")
    assert res.status_code in (401, 403)

    user_headers = {"Authorization": "Bearer test-mock-token-other"}
    from tests.admin_helpers import provision_user

    provision_user(client, user_headers)
    res = client.get("/admin/security/audit", headers=user_headers)
    assert res.status_code == 403


def test_audit_lists_rows_with_resolved_admin(client):
    admin_headers = make_admin(client, auth_headers(client))
    admin_id = get_user_id("test@example.com")
    _seed_user("target", "target@example.com")

    client.patch(
        "/admin/users/target/role", headers=admin_headers, json={"role": "admin"}
    )

    res = client.get("/admin/security/audit", headers=admin_headers)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["total"] >= 1
    assert body["page"] == 1
    assert body["pages"] >= 1
    newest = body["items"][0]
    assert newest["action"] == "user.role.change"
    assert newest["admin_user_id"] == admin_id
    assert newest["admin_email"] == _admin_email(client, admin_headers)
    assert newest["admin_name"] is not None
    assert newest["target_type"] == "user"
    assert newest["target_id"] == "target"
    assert newest["details"] == {"from": "user", "to": "admin"}
    assert newest["ip_address"] == "testclient"
    assert isinstance(newest["created_at"], int)


def test_audit_pagination_and_action_filter(client):
    admin_headers = make_admin(client, auth_headers(client))
    admin_id = get_user_id("test@example.com")
    _seed_audit_rows(admin_id, 5)

    res = client.get(
        "/admin/security/audit", headers=admin_headers, params={"page": 1, "page_size": 2}
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert len(body["items"]) == 2
    assert body["total"] >= 5
    assert body["pages"] >= 3

    res = client.get(
        "/admin/security/audit",
        headers=admin_headers,
        params={"action": "test.action.3"},
    )
    assert res.status_code == 200
    items = res.json()["items"]
    assert len(items) == 1
    assert items[0]["action"] == "test.action.3"
    assert items[0]["details"] == {"seq": 3}


def test_audit_oldest_first_and_search(client):
    admin_headers = make_admin(client, auth_headers(client))
    admin_id = get_user_id("test@example.com")
    _seed_audit_rows(admin_id, 3)

    res = client.get(
        "/admin/security/audit",
        headers=admin_headers,
        params={"sort_dir": "asc", "page_size": 1},
    )
    assert res.status_code == 200
    assert res.json()["items"][0]["action"] == "test.action.0"

    res = client.get(
        "/admin/security/audit", headers=admin_headers, params={"search": "target-2"}
    )
    assert res.status_code == 200
    items = res.json()["items"]
    assert len(items) == 1
    assert items[0]["target_id"] == "target-2"


def test_audit_date_range_and_admin_filter(client):
    admin_headers = make_admin(client, auth_headers(client))
    admin_id = get_user_id("test@example.com")
    _seed_audit_rows(admin_id, 4)

    res = client.get(
        "/admin/security/audit",
        headers=admin_headers,
        params={"from_ms": 1_000_002, "to_ms": 1_000_003},
    )
    assert res.status_code == 200
    actions = {item["action"] for item in res.json()["items"]}
    assert actions == {"test.action.2", "test.action.3"}

    res = client.get(
        "/admin/security/audit",
        headers=admin_headers,
        params={"admin_user_id": admin_id},
    )
    assert res.status_code == 200
    assert res.json()["total"] >= 4

    # Unknown admin id returns nothing, not a 500.
    res = client.get(
        "/admin/security/audit",
        headers=admin_headers,
        params={"admin_user_id": "does-not-exist"},
    )
    assert res.status_code == 200
    assert res.json()["items"] == []


def test_audit_never_exposes_sensitive_fields(client):
    admin_headers = make_admin(client, auth_headers(client))
    admin_id = get_user_id("test@example.com")
    _seed_audit_rows(admin_id, 1)

    res = client.get("/admin/security/audit", headers=admin_headers)
    assert res.status_code == 200
    for item in res.json()["items"]:
        assert "password" not in json.dumps(item).lower()
        assert "api_key" not in json.dumps(item).lower()
        assert "token" not in json.dumps(item).lower()
        assert "secret" not in json.dumps(item).lower()
