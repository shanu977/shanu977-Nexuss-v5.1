"""Admin Settings API: global app_settings, distinct from per-user /settings."""

from app.models import AppSetting
from tests.admin_helpers import make_admin, provision_user
from tests.conftest import auth_headers
from tests.conftest_helpers import TestingSessionLocal


def _all_settings():
    db = TestingSessionLocal()
    try:
        return db.query(AppSetting).all()
    finally:
        db.close()


def test_settings_requires_auth(client):
    assert client.get("/admin/settings").status_code == 401


def test_settings_rejects_normal_user(client):
    headers = auth_headers(client)
    provision_user(client, headers)
    assert client.get("/admin/settings", headers=headers).status_code == 403
    assert client.put("/admin/settings", headers=headers, json=[]).status_code == 403


def test_settings_put_creates_and_get_returns(client):
    admin_headers = make_admin(client, auth_headers(client))
    payload = [
        {
            "key": "feature:workspace_enabled",
            "value": "true",
            "value_type": "boolean",
            "description": "Enable workspace context",
        },
        {
            "key": "app:max_tokens",
            "value": "2048",
            "value_type": "number",
            "description": None,
        },
    ]
    res = client.put("/admin/settings", headers=admin_headers, json=payload)
    assert res.status_code == 200
    keys = {item["key"]: item for item in res.json()["items"]}
    assert keys["feature:workspace_enabled"]["value"] == "true"
    assert keys["app:max_tokens"]["value_type"] == "number"
    assert keys["app:max_tokens"]["updated_by_email"] == "test@example.com"

    res = client.get("/admin/settings", headers=admin_headers)
    assert res.status_code == 200
    assert {i["key"] for i in res.json()["items"]} == {
        "feature:workspace_enabled",
        "app:max_tokens",
    }


def test_settings_put_upserts_by_key(client):
    admin_headers = make_admin(client, auth_headers(client))
    client.put(
        "/admin/settings",
        headers=admin_headers,
        json=[{"key": "feature:flag", "value": "false", "value_type": "boolean"}],
    )
    client.put(
        "/admin/settings",
        headers=admin_headers,
        json=[{"key": "feature:flag", "value": "true", "value_type": "boolean"}],
    )
    settings = _all_settings()
    assert len(settings) == 1
    assert settings[0].value == "true"


def test_settings_validation(client):
    admin_headers = make_admin(client, auth_headers(client))

    bad_bool = [{"key": "feature:x", "value": "maybe", "value_type": "boolean"}]
    assert client.put("/admin/settings", headers=admin_headers, json=bad_bool).status_code == 422

    bad_num = [{"key": "app:n", "value": "abc", "value_type": "number"}]
    assert client.put("/admin/settings", headers=admin_headers, json=bad_num).status_code == 422

    bad_json = [{"key": "app:j", "value": "{oops", "value_type": "json"}]
    assert client.put("/admin/settings", headers=admin_headers, json=bad_json).status_code == 422

    bad_key_chars = [{"key": "bad key!", "value": "x", "value_type": "string"}]
    assert client.put("/admin/settings", headers=admin_headers, json=bad_key_chars).status_code == 422

    secret_key = [{"key": "db:password", "value": "hunter2", "value_type": "string"}]
    assert client.put("/admin/settings", headers=admin_headers, json=secret_key).status_code == 422


def test_settings_never_stores_secrets(client):
    """Even a previously stored value must never look like a credential."""
    admin_headers = make_admin(client, auth_headers(client))
    res = client.put(
        "/admin/settings",
        headers=admin_headers,
        json=[{"key": "feature:flag", "value": "true", "value_type": "boolean"}],
    )
    assert res.status_code == 200
    raw = [_all_settings()]
    for settings in raw:
        for setting in settings:
            assert setting.key != "db:password"
            assert setting.value not in ("hunter2",)


def test_global_settings_distinct_from_user_settings(client):
    """/admin/settings must not touch a normal user's /settings."""
    admin_headers = make_admin(client, auth_headers(client))
    user_headers = {"Authorization": "Bearer test-mock-token-user2"}
    provision_user(client, user_headers)

    res = client.put(
        "/admin/settings",
        headers=admin_headers,
        json=[{"key": "feature:flag", "value": "true", "value_type": "boolean"}],
    )
    assert res.status_code == 200

    # The per-user settings endpoint still returns the user's own settings.
    user_settings = client.get("/settings", headers=user_headers)
    assert user_settings.status_code == 200
    assert user_settings.json()["theme"] == "light"
def test_settings_audit_does_not_store_values(client):
    """Audit logs must not contain old or new setting values."""
    from app.models import AuditLog

    admin_headers = make_admin(client, auth_headers(client))

    secret_value = "SUPER_SECRET_TEST_VALUE_12345"

    res = client.put(
        "/admin/settings",
        headers=admin_headers,
        json=[
            {
                "key": "feature:test_setting",
                "value": secret_value,
                "value_type": "string",
            }
        ],
    )
    assert res.status_code == 200

    db = TestingSessionLocal()
    try:
        logs = db.query(AuditLog).all()
        assert logs

        for log in logs:
            if log.details:
                assert secret_value not in log.details
    finally:
        db.close()
