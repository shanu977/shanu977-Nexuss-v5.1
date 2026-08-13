"""Firebase Admin initialization hardening.

The production 401 (``Invalid authentication token.``) is the backend failing
to verify a well-formed Bearer token. These tests pin down the credential
resolution and fail-fast behavior so a broken Firebase Admin setup can never
silently 401 every request again.
"""

import os

import pytest

from app.services import firebase_service


def _no_creds(monkeypatch):
    """Point every Firebase credential source at nothing."""
    for attr in (
        "environment",
        "firebase_credentials_path",
        "firebase_project_id",
        "firebase_client_email",
        "firebase_private_key",
    ):
        monkeypatch.setattr(firebase_service.settings, attr, "" if attr != "environment" else "development")


def _disable_test_env(monkeypatch):
    """Make the SDK take the real (non-pytest) initialization path.

    Earlier tests that use the ``client`` fixture can trigger a real
    ``firebase_admin.initialize_app`` against the local ``.env`` credential
    (the lifespan runs before pytest has exported PYTEST_CURRENT_TEST), leaving
    a live app in ``firebase_admin._apps``. We neutralize that so these tests
    exercise the credential-resolution logic deterministically.
    """
    import firebase_admin

    monkeypatch.delenv("PYTEST_CURRENT_TEST", raising=False)
    monkeypatch.setattr(firebase_admin, "_apps", {})
    firebase_service._firebase_initialized = False


def test_load_credentials_none_when_all_sources_empty(monkeypatch):
    _no_creds(monkeypatch)
    assert firebase_service._load_credentials() == (None, None)


def test_load_credentials_raises_when_configured_path_missing(monkeypatch):
    _no_creds(monkeypatch)
    monkeypatch.setattr(
        firebase_service.settings,
        "firebase_credentials_path",
        "./definitely-not-deployed.json",
    )
    with pytest.raises(ValueError, match="FIREBASE_CREDENTIALS_PATH"):
        firebase_service._load_credentials()


def test_load_credentials_raises_when_component_build_fails(monkeypatch):
    """All three component vars set but the key is unusable => no credential,
    and the caller (initialize_firebase) fails fast rather than defaulting."""
    _no_creds(monkeypatch)
    monkeypatch.setattr(firebase_service.settings, "firebase_project_id", "p")
    monkeypatch.setattr(
        firebase_service.settings,
        "firebase_client_email",
        "admin@p.iam.gserviceaccount.com",
    )
    monkeypatch.setattr(firebase_service.settings, "firebase_private_key", "not-a-real-key")
    assert firebase_service._load_credentials() == (None, None)


def test_production_fails_fast_without_credentials(monkeypatch):
    """A production backend with no service-account credential refuses to
    start instead of starting a default app that 401s every request."""
    _no_creds(monkeypatch)
    monkeypatch.setattr(firebase_service.settings, "environment", "production")
    _disable_test_env(monkeypatch)

    with pytest.raises(RuntimeError, match="FIREBASE_PRIVATE_KEY"):
        firebase_service.initialize_firebase()


def test_production_fails_fast_when_configured_path_missing(monkeypatch):
    _no_creds(monkeypatch)
    monkeypatch.setattr(firebase_service.settings, "environment", "production")
    monkeypatch.setattr(
        firebase_service.settings,
        "firebase_credentials_path",
        "./definitely-not-deployed.json",
    )
    _disable_test_env(monkeypatch)

    with pytest.raises(RuntimeError, match="Firebase Admin SDK failed to initialize"):
        firebase_service.initialize_firebase()


def test_development_without_credentials_warns_and_does_not_raise(monkeypatch):
    _no_creds(monkeypatch)
    _disable_test_env(monkeypatch)

    firebase_service.initialize_firebase()  # must not raise
    assert firebase_service._firebase_initialized is False


def test_invalid_bearer_token_401_invalid_authentication_token(client, monkeypatch):
    """A well-formed Bearer header with an unverifiable token returns exactly
    the production error: 401 with detail 'Invalid authentication token.'.

    This is the same code path the browser hits when the backend cannot verify
    the Firebase ID token (admin SDK misinitialized / wrong project).
    """
    _no_creds(monkeypatch)
    _disable_test_env(monkeypatch)

    was_set = "PYTEST_CURRENT_TEST" in os.environ
    os.environ.pop("PYTEST_CURRENT_TEST", None)
    try:
        res = client.get(
            "/api-keys", headers={"Authorization": "Bearer unverifiable-token"}
        )
        assert res.status_code == 401
        assert res.json()["detail"] == "Invalid authentication token."
    finally:
        if was_set:
            os.environ["PYTEST_CURRENT_TEST"] = "1"