"""Shared helpers for Admin API tests."""

from app.models import User
from tests.conftest_helpers import TestingSessionLocal


def provision_user(client, headers):
    """Any authenticated endpoint provisions the user on first request."""
    res = client.get("/settings", headers=headers)
    assert res.status_code == 200, res.text


def set_role(email: str, role: str, name: str = "shanmuk", status: str = "active") -> None:
    """Update a provisioned user's server-side role directly in the DB."""
    db = TestingSessionLocal()
    try:
        user = db.query(User).filter(User.email == email).first()
        assert user is not None, f"User {email} was not provisioned"
        user.role = role
        user.name = name
        user.status = status
        db.commit()
    finally:
        db.close()


def make_admin(client, headers, email="pillishanu5@gmail.com"):
    """Provision the given user and promote them to admin. Returns headers."""
    provision_user(client, headers)
    set_role(email, "admin")
    return headers


def get_user_id(email: str) -> str:
    db = TestingSessionLocal()
    try:
        user = db.query(User).filter(User.email == email).first()
        assert user is not None, f"User {email} was not provisioned"
        return user.id
    finally:
        db.close()
