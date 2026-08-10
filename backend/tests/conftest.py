import pytest
from fastapi.testclient import TestClient

from tests.conftest_helpers import TestingSessionLocal, engine, override_get_db

from app.database import Base, get_db
from app.main import app

app.dependency_overrides[get_db] = override_get_db


@pytest.fixture(autouse=True)
def reset_db():
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    yield


@pytest.fixture(autouse=True)
def mock_email_sender(monkeypatch):
    """Never send real email during automated tests.

    Captures every OTP email the app would have delivered so tests can assert
    the sender was called with the generated code without touching SMTP.
    """
    from app.services import email_service

    captured = {"emails": []}

    def _fake(to_email, otp_code, **kwargs):
        captured["emails"].append({"to": to_email, "code": otp_code})

    monkeypatch.setattr(email_service, "send_otp_email", _fake)
    return captured


@pytest.fixture(autouse=True)
def reset_rate_limit():
    """Clear in-memory rate-limit windows after each test.

    All TestClient requests share the same socket peer address, so the whole
    suite would otherwise exhaust the 60-requests/minute budget mid-run.
    """
    from app.middleware.rate_limit import reset_rate_limits

    yield
    reset_rate_limits()


@pytest.fixture(autouse=True)
def reset_fallback_state():
    """Clear in-memory provider cooldowns after each test so rate-limit state
    never leaks from one fallback test into another."""
    from app.services.fallback_service import reset_fallback_state

    yield
    reset_fallback_state()


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def auth_headers(client, email="test@example.com", name="Test User"):
    """Return Bearer authorization headers for testing."""
    return {"Authorization": "Bearer test-mock-token"}
