"""Admin Feedback API: listing, filters, pagination, status updates."""

from app.models import Feedback, User
from app.models.models import utc_now_ms
from tests.admin_helpers import make_admin, provision_user
from tests.conftest import auth_headers
from tests.conftest_helpers import TestingSessionLocal


def _seed_feedback(user_id, rating=None, message="Nice app", status="new", created_at=None):
    db = TestingSessionLocal()
    try:
        fb = Feedback(
            user_id=user_id,
            rating=rating,
            message=message,
            status=status,
            created_at=created_at or utc_now_ms(),
        )
        db.add(fb)
        db.commit()
        return fb.id
    finally:
        db.close()


def _seed_user(user_id, email):
    db = TestingSessionLocal()
    try:
        db.add(User(id=user_id, email=email, name="Seed"))
        db.commit()
    finally:
        db.close()


def test_feedback_requires_auth(client):
    assert client.get("/admin/feedback").status_code == 401


def test_feedback_rejects_normal_user(client):
    headers = auth_headers(client)
    provision_user(client, headers)
    assert client.get("/admin/feedback", headers=headers).status_code == 403


def test_feedback_list_joins_user(client):
    admin_headers = make_admin(client, auth_headers(client))
    _seed_user("feedback-user", "feedback@example.com")
    _seed_feedback("feedback-user", rating=5, message="Love it")

    res = client.get("/admin/feedback", headers=admin_headers)
    assert res.status_code == 200
    body = res.json()
    assert body["total"] == 1
    item = body["items"][0]
    assert item["user"]["email"] == "feedback@example.com"
    assert item["rating"] == 5
    assert item["message"] == "Love it"
    assert item["status"] == "new"
    assert item["created_at"] > 0


def test_feedback_pagination_and_filters(client):
    admin_headers = make_admin(client, auth_headers(client))
    _seed_user("u1", "u1@example.com")
    _seed_feedback("u1", rating=5, status="new")
    _seed_feedback("u1", rating=1, status="closed")
    _seed_feedback("u1", rating=3, status="reviewed")

    res = client.get("/admin/feedback", headers=admin_headers, params={"status": "new"})
    assert res.json()["total"] == 1

    res = client.get("/admin/feedback", headers=admin_headers, params={"rating": 1})
    assert res.json()["total"] == 1

    res = client.get("/admin/feedback", headers=admin_headers, params={"page_size": 2})
    body = res.json()
    assert body["total"] == 3
    assert len(body["items"]) == 2
    assert body["pages"] == 2

    res = client.get("/admin/feedback", headers=admin_headers, params={"search": "bad status"})
    assert res.json()["total"] == 0


def test_feedback_invalid_filters(client):
    admin_headers = make_admin(client, auth_headers(client))
    assert client.get("/admin/feedback", headers=admin_headers, params={"status": "bogus"}).status_code == 400
    assert client.get("/admin/feedback", headers=admin_headers, params={"rating": 9}).status_code == 422
    assert client.get("/admin/feedback", headers=admin_headers, params={"sort_by": "id"}).status_code == 400


def test_feedback_status_update(client):
    admin_headers = make_admin(client, auth_headers(client))
    _seed_user("u1", "u1@example.com")
    fb_id = _seed_feedback("u1", rating=4, status="new")

    res = client.patch(
        f"/admin/feedback/{fb_id}", headers=admin_headers, json={"status": "reviewed"}
    )
    assert res.status_code == 200
    assert res.json()["status"] == "reviewed"
    assert res.json()["user"]["email"] == "u1@example.com"


def test_feedback_status_update_invalid(client):
    admin_headers = make_admin(client, auth_headers(client))
    _seed_user("u1", "u1@example.com")
    fb_id = _seed_feedback("u1")

    assert client.patch(
        f"/admin/feedback/{fb_id}", headers=admin_headers, json={"status": "spam"}
    ).status_code == 422
    assert client.patch(
        "/admin/feedback/missing", headers=admin_headers, json={"status": "closed"}
    ).status_code == 404
