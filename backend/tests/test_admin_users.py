"""Admin Users API: listing, pagination, search, filters, role management,
block/unblock enforcement, deletion, and authorization."""

from app.models import Conversation, Message, User
from tests.admin_helpers import get_user_id, make_admin, provision_user
from tests.conftest import auth_headers
from tests.conftest_helpers import TestingSessionLocal

ADMIN_HEADERS = auth_headers


def _seed_user(email, name="Seed User", role="user", status="active", uid=None, **kw):
    db = TestingSessionLocal()
    try:
        user = User(
            id=kw.pop("id", email.replace("@", "_")),
            email=email,
            name=name,
            role=role,
            status=status,
            firebase_uid=uid,
            **kw,
        )
        db.add(user)
        db.commit()
        return user.id
    finally:
        db.close()


def _seed_users(*emails):
    return [_seed_user(e) for e in emails]


def test_users_requires_auth(client):
    assert client.get("/admin/users").status_code == 401


def test_users_rejects_normal_user(client):
    headers = auth_headers(client)
    provision_user(client, headers)
    assert client.get("/admin/users", headers=headers).status_code == 403


def test_users_allows_admin(client):
    headers = make_admin(client, auth_headers(client))
    _seed_users("a@example.com", "b@example.com")
    res = client.get("/admin/users", headers=headers)
    assert res.status_code == 200
    body = res.json()
    assert body["total"] >= 3
    assert body["page"] == 1
    assert body["pages"] >= 1
    fields = {"id", "email", "name", "role", "status", "created_at", "updated_at", "photo_url", "provider"}
    for item in body["items"]:
        assert fields <= set(item.keys())


def test_users_pagination(client):
    headers = make_admin(client, auth_headers(client))
    _seed_users(*[f"user{i}@example.com" for i in range(5)])

    res = client.get("/admin/users", headers=headers, params={"page_size": 2, "page": 1})
    body = res.json()
    assert body["total"] == 6
    assert len(body["items"]) == 2
    assert body["pages"] == 3

    res3 = client.get("/admin/users", headers=headers, params={"page_size": 2, "page": 3})
    assert len(res3.json()["items"]) == 2


def test_users_search_by_email(client):
    headers = make_admin(client, auth_headers(client))
    _seed_users("alice@example.com", "bob@example.com")

    res = client.get("/admin/users", headers=headers, params={"search": "alice"})
    body = res.json()
    assert body["total"] == 1
    assert body["items"][0]["email"] == "alice@example.com"


def test_users_filter_by_role(client):
    headers = make_admin(client, auth_headers(client))
    _seed_users("normal@example.com")
    _seed_user("boss@example.com", role="admin", id="boss_user")

    res = client.get("/admin/users", headers=headers, params={"role": "admin"})
    emails = [i["email"] for i in res.json()["items"]]
    assert "boss@example.com" in emails
    assert "normal@example.com" not in emails


def test_users_filter_by_status(client):
    headers = make_admin(client, auth_headers(client))
    _seed_users("ok@example.com")
    _seed_user("bad@example.com", status="blocked")

    res = client.get("/admin/users", headers=headers, params={"status": "blocked"})
    emails = [i["email"] for i in res.json()["items"]]
    assert "bad@example.com" in emails
    assert "ok@example.com" not in emails


def test_users_sort_and_invalid_query_params(client):
    headers = make_admin(client, auth_headers(client))
    res = client.get("/admin/users", headers=headers, params={"sort_by": "email", "sort_dir": "asc"})
    assert res.status_code == 200

    assert client.get("/admin/users", headers=headers, params={"role": "root"}).status_code == 400
    assert client.get("/admin/users", headers=headers, params={"status": "ghost"}).status_code == 400
    assert client.get("/admin/users", headers=headers, params={"sort_by": "password"}).status_code == 400
    assert client.get("/admin/users", headers=headers, params={"sort_dir": "up"}).status_code == 400


def test_role_change_promotes_user(client):
    admin_headers = make_admin(client, auth_headers(client))
    target = _seed_user("promote@example.com", id="promote_user")

    res = client.patch(
        f"/admin/users/{target}/role", headers=admin_headers, json={"role": "admin"}
    )
    assert res.status_code == 200
    assert res.json()["role"] == "admin"

    db = TestingSessionLocal()
    try:
        assert db.query(User).filter(User.id == target).one().role == "admin"
    finally:
        db.close()


def test_role_change_demotes_second_admin_ok(client):
    admin_headers = make_admin(client, auth_headers(client))
    second = _seed_user("second-admin@example.com", role="admin", id="second_admin")

    res = client.patch(
        f"/admin/users/{second}/role", headers=admin_headers, json={"role": "user"}
    )
    assert res.status_code == 200
    assert res.json()["role"] == "user"


def test_role_change_cannot_demote_only_admin(client):
    admin_headers = make_admin(client, auth_headers(client))
    self_id = get_user_id("test@example.com")

    res = client.patch(
        f"/admin/users/{self_id}/role", headers=admin_headers, json={"role": "user"}
    )
    assert res.status_code == 400
    assert "only remaining admin" in res.json()["detail"]


def test_role_change_invalid_role_rejected(client):
    admin_headers = make_admin(client, auth_headers(client))
    target = _seed_user("rolebad@example.com", id="rolebad_user")
    res = client.patch(
        f"/admin/users/{target}/role", headers=admin_headers, json={"role": "superuser"}
    )
    assert res.status_code == 422


def test_block_and_unblock_enforces_status(client):
    admin_headers = make_admin(client, auth_headers(client))
    target_headers = {"Authorization": "Bearer test-mock-token-blocked"}
    provision_user(client, target_headers)
    target_id = get_user_id("test-mock-token-blocked@example.com")

    res = client.post(f"/admin/users/{target_id}/block", headers=admin_headers)
    assert res.status_code == 200
    assert res.json()["status"] == "blocked"

    # The blocked user can no longer use the application.
    assert client.get("/settings", headers=target_headers).status_code == 403

    res = client.post(f"/admin/users/{target_id}/unblock", headers=admin_headers)
    assert res.status_code == 200
    assert res.json()["status"] == "active"

    assert client.get("/settings", headers=target_headers).status_code == 200


def test_cannot_block_admin(client):
    admin_headers = make_admin(client, auth_headers(client))
    second = _seed_user("boss@example.com", role="admin", id="boss_user")
    res = client.post(f"/admin/users/{second}/block", headers=admin_headers)
    assert res.status_code == 400
    assert "administrator" in res.json()["detail"].lower()


def test_cannot_block_missing_user(client):
    admin_headers = make_admin(client, auth_headers(client))
    assert client.post("/admin/users/nope/block", headers=admin_headers).status_code == 404


def test_delete_user_removes_data_and_audit_survives(client):
    admin_headers = make_admin(client, auth_headers(client))
    target_id = _seed_user("doomed@example.com", name="Doomed", id="doomed_user")

    db = TestingSessionLocal()
    try:
        target = db.query(User).filter(User.id == target_id).one()
        conv = Conversation(user=target, title="hi")
        db.add(conv)
        db.commit()
        conv_id = conv.id
    finally:
        db.close()

    res = client.delete(f"/admin/users/{target_id}", headers=admin_headers)
    assert res.status_code == 200
    assert res.json() == {"status": "deleted", "id": target_id}

    db = TestingSessionLocal()
    try:
        assert db.query(User).filter(User.id == target_id).first() is None
        assert db.query(Conversation).filter(Conversation.id == conv_id).first() is None
        assert db.query(Message).filter(Message.conversation_id == conv_id).first() is None
        # The audit trail survives the deleted user's data removal.
        from app.models import AuditLog

        assert db.query(AuditLog).filter(
            AuditLog.action == "user.delete", AuditLog.target_id == target_id
        ).count() == 1
    finally:
        db.close()


def test_cannot_delete_self_or_admin(client):
    admin_headers = make_admin(client, auth_headers(client))
    self_id = get_user_id("test@example.com")
    assert client.delete(f"/admin/users/{self_id}", headers=admin_headers).status_code == 400

    second = _seed_user("boss@example.com", role="admin", id="boss_user")
    assert client.delete(f"/admin/users/{second}", headers=admin_headers).status_code == 400


def test_admin_authorization_ignores_client_role_field(client):
    """A request body/query 'role: admin' must never grant access."""
    headers = auth_headers(client)
    provision_user(client, headers)
    res = client.get("/admin/users", headers=headers, params={"role": "admin"})
    assert res.status_code == 403
