"""Regression tests for real email delivery of OTP codes.

Real SMTP is never contacted during tests: the email sender is mocked. These
tests verify the OTP email is produced with the generated code, that the code
is never logged or persisted in plaintext, that SMTP credentials are wired to
the mail server without leaking, and that a delivery failure is handled safely
(no success reported, no valid OTP left behind, no secrets exposed).
"""

import logging
import smtplib

import pytest

from app.models import EmailOTP
from app.services import email_service
from tests.conftest_helpers import TestingSessionLocal

EMAIL = "alice@example.com"
SMTP_USER = "mail-user"
SMTP_PW = "super-secret-smtp-password-xyz"


@pytest.fixture
def fixed_otp(monkeypatch):
    """Force OTP generation to a deterministic code ("555555")."""
    import app.routes.auth as auth_module

    monkeypatch.setattr(auth_module.secrets, "choice", lambda seq: "5")
    return "555555"


@pytest.fixture
def smtp_settings(monkeypatch):
    monkeypatch.setattr(email_service.settings, "smtp_host", "smtp.example.com")
    monkeypatch.setattr(email_service.settings, "smtp_port", 587)
    monkeypatch.setattr(email_service.settings, "smtp_username", SMTP_USER)
    monkeypatch.setattr(email_service.settings, "smtp_password", SMTP_PW)
    monkeypatch.setattr(
        email_service.settings, "smtp_from_email", "no-reply@example.com"
    )
    monkeypatch.setattr(email_service.settings, "smtp_from_name", "AI Chatbot")


# ----------------------------------------------------- sender is called


def test_send_otp_calls_email_sender_with_generated_code(client, mock_email_sender, fixed_otp):
    res = client.post("/auth/otp/send", json={"email": EMAIL})
    assert res.status_code == 200
    assert mock_email_sender["emails"] == [{"to": EMAIL, "code": "555555"}]


# ----------------------------------------------------- email content


def test_otp_email_contains_generated_code(fixed_otp, smtp_settings):
    message = email_service.build_otp_message(EMAIL, "555555")
    assert message["Subject"] == "Your password setup verification code"
    assert message["To"] == EMAIL
    body = message.get_content()
    assert "555555" in body
    assert "10 minutes" in body
    assert "ignore this email" in body


def test_otp_email_never_contains_secrets(fixed_otp, smtp_settings):
    message = email_service.build_otp_message(EMAIL, "555555")
    rendered = str(message)
    assert SMTP_PW not in rendered
    assert SMTP_USER not in rendered
    assert "otp_hash" not in rendered.lower()
    assert "firebase" not in rendered.lower()
    assert "api_key" not in rendered.lower()
    # The only "code" in the email is the OTP itself.
    assert rendered.count("555555") == 1


# ----------------------------------------------------- SMTP wiring


def test_send_email_uses_smtp_credentials(monkeypatch, smtp_settings):
    class FakeSMTP:
        instances = []

        def __init__(self, host, port, timeout=None):
            FakeSMTP.instances.append(self)
            self.host = host
            self.port = port
            self.started_tls = False
            self.logged_in = None
            self.sent = None

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def ehlo(self):
            return (250, b"ok")

        def starttls(self):
            self.started_tls = True

        def login(self, user, pw):
            self.logged_in = (user, pw)

        def send_message(self, message):
            self.sent = message

    monkeypatch.setattr(email_service, "_IPv4SMTP", FakeSMTP)
    FakeSMTP.instances.clear()

    email_service.send_email("bob@example.com", "Hello", "body")

    inst = FakeSMTP.instances[0]
    assert inst.host == "smtp.example.com"
    assert inst.port == 587
    assert inst.started_tls is True
    assert inst.logged_in == (SMTP_USER, SMTP_PW)
    assert inst.sent is not None
    assert inst.sent["Subject"] == "Hello"
    assert inst.sent["From"] == "AI Chatbot <no-reply@example.com>"


def test_send_email_rejects_when_unconfigured(monkeypatch):
    # Hermetic: the test must not depend on the ambient .env (a developer's
    # local SMTP config would otherwise make this assertion fail).
    monkeypatch.setattr(email_service.settings, "smtp_host", "")
    assert email_service.settings.smtp_host == ""
    with pytest.raises(email_service.EmailDeliveryError):
        email_service.send_email("x@example.com", "s", "b")


def test_send_email_ssl_port_uses_smtp_ssl(monkeypatch, smtp_settings):
    monkeypatch.setattr(email_service.settings, "smtp_port", 465)

    class FakeSMTPSSL:
        instances = []

        def __init__(self, host, port, timeout=None):
            FakeSMTPSSL.instances.append((host, port))

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def ehlo(self):
            pass

        def login(self, user, pw):
            pass

        def send_message(self, message):
            pass

    monkeypatch.setattr(email_service, "_IPv4SMTP_SSL", FakeSMTPSSL)
    FakeSMTPSSL.instances.clear()

    email_service.send_email("bob@example.com", "s", "b")
    assert FakeSMTPSSL.instances == [("smtp.example.com", 465)]


# ----------------------------------------------------- safe failure


def test_email_failure_returns_safe_error_and_rolls_back(client, monkeypatch):
    def _boom(to_email, otp_code):
        raise email_service.EmailDeliveryError("boom")

    monkeypatch.setattr(email_service, "send_otp_email", _boom)

    res = client.post("/auth/otp/send", json={"email": EMAIL})
    assert res.status_code == 502
    assert SMTP_PW not in res.text
    assert SMTP_USER not in res.text
    assert "smtp" not in res.text.lower()

    # No valid OTP row was left behind (transaction rolled back).
    db = TestingSessionLocal()
    try:
        record = db.query(EmailOTP).filter(EmailOTP.email == EMAIL).first()
    finally:
        db.close()
    assert record is None


def test_email_failure_does_not_bypass_cooldown(client, mock_email_sender, monkeypatch, fixed_otp):
    # First send succeeds and starts the cooldown window.
    assert client.post("/auth/otp/send", json={"email": EMAIL}).status_code == 200

    # A later delivery failure must not erase the cooldown for the issued OTP.
    def _boom(to_email, otp_code):
        raise email_service.EmailDeliveryError("boom")

    monkeypatch.setattr(email_service, "send_otp_email", _boom)
    res = client.post("/auth/otp/send", json={"email": EMAIL})
    # Cooldown applies before delivery, so the request is still rate-limited.
    assert res.status_code == 429


def test_smtp_failure_never_logs_credentials(monkeypatch, smtp_settings, caplog):
    def _raise(*args, **kwargs):
        raise smtplib.SMTPAuthenticationError(535, b"authentication failed")

    monkeypatch.setattr(email_service, "_IPv4SMTP", _raise)

    with caplog.at_level(logging.WARNING):
        with pytest.raises(email_service.EmailDeliveryError):
            email_service.send_email("x@example.com", "s", "b")

    assert SMTP_PW not in caplog.text
    assert SMTP_USER not in caplog.text


def test_smtp_credentials_never_reach_the_api(client, mock_email_sender, fixed_otp):
    res = client.post("/auth/otp/send", json={"email": EMAIL})
    assert res.status_code == 200
    assert SMTP_USER not in res.text
    assert SMTP_PW not in res.text


# ----------------------------------------------------- no regressions


def test_otp_never_logged(client, caplog, fixed_otp):
    with caplog.at_level(logging.INFO):
        res = client.post("/auth/otp/send", json={"email": EMAIL})
    assert res.status_code == 200
    assert "555555" not in caplog.text


def test_otp_hash_remains_stored_not_plaintext(client, fixed_otp):
    client.post("/auth/otp/send", json={"email": EMAIL})
    db = TestingSessionLocal()
    try:
        record = db.query(EmailOTP).filter(EmailOTP.email == EMAIL).first()
    finally:
        db.close()
    assert record is not None
    assert record.otp_hash != "555555"
    assert "555555" not in record.otp_hash


def test_existing_verification_flow_still_works(client, fixed_otp):
    assert client.post("/auth/otp/send", json={"email": EMAIL}).status_code == 200
    ok = client.post("/auth/otp/verify", json={"email": EMAIL, "otp": "555555"})
    assert ok.status_code == 200
    assert ok.json()["verified"] is True
    bad = client.post("/auth/otp/verify", json={"email": EMAIL, "otp": "000000"})
    assert bad.status_code == 400
