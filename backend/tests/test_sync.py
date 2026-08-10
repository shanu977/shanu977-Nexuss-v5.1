import pytest

from tests.conftest import auth_headers


def _now():
    import time
    return int(time.time() * 1000)


def test_push_and_pull_conversation(client):
    headers = auth_headers(client)
    now = _now()
    push = client.post(
        "/sync/push",
        headers=headers,
        json={
            "conversations": [
                {"id": "conv-1", "title": "Hello", "provider": "groq",
                 "createdAt": now, "updatedAt": now}
            ],
            "messages": [
                {"id": "msg-1", "chatId": "conv-1", "role": "user",
                 "content": "hi", "timestamp": now},
                {"id": "msg-2", "chatId": "conv-1", "role": "assistant",
                 "content": "hello!", "timestamp": now}
            ],
            "deletedConversations": [],
            "deletedMessages": [],
        },
    )
    assert push.status_code == 200
    assert push.json()["accepted"] is True

    pull = client.get("/sync/pull?since=0", headers=headers)
    assert pull.status_code == 200
    body = pull.json()
    assert len(body["conversations"]) == 1
    assert body["conversations"][0]["id"] == "conv-1"
    assert len(body["messages"]) == 2
    roles = {m["role"] for m in body["messages"]}
    assert roles == {"user", "assistant"}


def test_message_upsert_is_idempotent(client):
    headers = auth_headers(client)
    now = _now()
    payload = {
        "conversations": [
            {"id": "c", "title": "t", "provider": None, "createdAt": now, "updatedAt": now}
        ],
        "messages": [
            {"id": "m", "chatId": "c", "role": "user", "content": "v1", "timestamp": now}
        ],
        "deletedConversations": [],
        "deletedMessages": [],
    }
    client.post("/sync/push", headers=headers, json=payload)
    # Push same message id again with different content - must be ignored
    payload["messages"][0]["content"] = "v2"
    resp = client.post("/sync/push", headers=headers, json=payload)
    assert resp.status_code == 200

    pull = client.get("/sync/pull?since=0", headers=headers).json()
    msgs = [m for m in pull["messages"] if m["id"] == "m"]
    assert msgs[0]["content"] == "v1"


def test_conflict_latest_updated_at_wins(client):
    headers = auth_headers(client)
    now = _now()

    def push_conv(updated_at):
        return client.post(
            "/sync/push",
            headers=headers,
            json={
                "conversations": [
                    {"id": "c", "title": "Old", "provider": "groq",
                     "createdAt": now, "updatedAt": updated_at}
                ],
                "messages": [],
                "deletedConversations": [],
                "deletedMessages": [],
            },
        )

    assert push_conv(now - 1000).status_code == 200
    assert push_conv(now).status_code == 200
    # Older push must NOT overwrite the newer server value
    assert push_conv(now - 5000).status_code == 200

    pull = client.get("/sync/pull?since=0", headers=headers).json()
    assert pull["conversations"][0]["updatedAt"] == now


def test_user_b_cannot_update_user_a_conversation(client):
    """Security: User B must not be able to overwrite User A's conversation
    title/provider by replaying the same conversation ID with a newer timestamp."""
    headers_a = {"Authorization": "Bearer test-mock-token-usera"}
    headers_b = {"Authorization": "Bearer test-mock-token-userb"}
    now = _now()

    # User A creates conversation X
    res = client.post("/sync/push", headers=headers_a, json={
        "conversations": [
            {"id": "conv-x", "title": "A's title", "provider": "groq",
             "createdAt": now, "updatedAt": now}
        ],
        "messages": [],
        "deletedConversations": [],
        "deletedMessages": [],
    })
    assert res.status_code == 200

    # User B attempts to update A's conversation with a newer timestamp
    res_b = client.post("/sync/push", headers=headers_b, json={
        "conversations": [
            {"id": "conv-x", "title": "B's malicious title", "provider": "gemini",
             "createdAt": now, "updatedAt": now + 10_000}
        ],
        "messages": [],
        "deletedConversations": [],
        "deletedMessages": [],
    })
    assert res_b.status_code == 200

    # A's conversation must be unchanged
    pull_a = client.get("/sync/pull?since=0", headers=headers_a).json()
    convs = {c["id"]: c for c in pull_a["conversations"]}
    assert convs["conv-x"]["title"] == "A's title"
    assert convs["conv-x"]["provider"] == "groq"
    assert convs["conv-x"]["updatedAt"] == now

    # B must not see A's conversation in their own pull
    pull_b = client.get("/sync/pull?since=0", headers=headers_b).json()
    assert pull_b["conversations"] == []


def test_user_a_can_still_update_own_conversation(client):
    """User A must still be able to update their own conversation."""
    headers_a = {"Authorization": "Bearer test-mock-token-usera"}
    now = _now()

    res = client.post("/sync/push", headers=headers_a, json={
        "conversations": [
            {"id": "conv-own", "title": "Original", "provider": "groq",
             "createdAt": now, "updatedAt": now}
        ],
        "messages": [],
        "deletedConversations": [],
        "deletedMessages": [],
    })
    assert res.status_code == 200

    # A updates own conversation with a newer timestamp
    res = client.post("/sync/push", headers=headers_a, json={
        "conversations": [
            {"id": "conv-own", "title": "Updated", "provider": "groq",
             "createdAt": now, "updatedAt": now + 5_000}
        ],
        "messages": [],
        "deletedConversations": [],
        "deletedMessages": [],
    })
    assert res.status_code == 200

    pull_a = client.get("/sync/pull?since=0", headers=headers_a).json()
    convs = {c["id"]: c for c in pull_a["conversations"]}
    assert convs["conv-own"]["title"] == "Updated"
    assert convs["conv-own"]["updatedAt"] == now + 5_000


def test_user_b_cannot_delete_user_a_conversation(client):
    """Security: User B must not be able to delete User A's conversation."""
    headers_a = {"Authorization": "Bearer test-mock-token-usera"}
    headers_b = {"Authorization": "Bearer test-mock-token-userb"}
    now = _now()

    res = client.post("/sync/push", headers=headers_a, json={
        "conversations": [
            {"id": "conv-del", "title": "Keep me", "provider": "groq",
             "createdAt": now, "updatedAt": now}
        ],
        "messages": [],
        "deletedConversations": [],
        "deletedMessages": [],
    })
    assert res.status_code == 200

    # B tries to delete A's conversation
    res_b = client.post("/sync/push", headers=headers_b, json={
        "conversations": [],
        "messages": [],
        "deletedConversations": ["conv-del"],
        "deletedMessages": [],
    })
    assert res_b.status_code == 200

    # A's conversation still exists
    pull_a = client.get("/sync/pull?since=0", headers=headers_a).json()
    ids = {c["id"] for c in pull_a["conversations"]}
    assert "conv-del" in ids


def test_user_b_cannot_delete_user_a_message(client):
    """Security: User B must not be able to delete User A's message."""
    headers_a = {"Authorization": "Bearer test-mock-token-usera"}
    headers_b = {"Authorization": "Bearer test-mock-token-userb"}
    now = _now()

    res = client.post("/sync/push", headers=headers_a, json={
        "conversations": [
            {"id": "conv-msg", "title": "t", "provider": None,
             "createdAt": now, "updatedAt": now}
        ],
        "messages": [
            {"id": "msg-a", "chatId": "conv-msg", "role": "user",
             "content": "secret", "timestamp": now}
        ],
        "deletedConversations": [],
        "deletedMessages": [],
    })
    assert res.status_code == 200

    # B tries to delete A's message
    res_b = client.post("/sync/push", headers=headers_b, json={
        "conversations": [],
        "messages": [],
        "deletedConversations": [],
        "deletedMessages": ["msg-a"],
    })
    assert res_b.status_code == 200

    # A's message still exists
    pull_a = client.get("/sync/pull?since=0", headers=headers_a).json()
    msg_ids = {m["id"] for m in pull_a["messages"]}
    assert "msg-a" in msg_ids


def test_pull_since_filter(client):
    headers = auth_headers(client)
    now = _now()
    client.post("/sync/push", headers=headers, json={
        "conversations": [{"id": "c1", "title": "t", "provider": None,
                           "createdAt": now, "updatedAt": now}],
        "messages": [], "deletedConversations": [], "deletedMessages": [],
    })
    later = now + 5000
    client.post("/sync/push", headers=headers, json={
        "conversations": [{"id": "c2", "title": "t2", "provider": None,
                           "createdAt": later, "updatedAt": later}],
        "messages": [], "deletedConversations": [], "deletedMessages": [],
    })
    pull = client.get(f"/sync/pull?since={now + 1}", headers=headers).json()
    ids = {c["id"] for c in pull["conversations"]}
    assert ids == {"c2"}


def test_rejects_message_for_unknown_conversation(client):
    headers = auth_headers(client)
    now = _now()
    # Push a message referencing a conversation that does not exist -> ignored.
    resp = client.post("/sync/push", headers=headers, json={
        "conversations": [], "messages": [
            {"id": "mX", "chatId": "missing-conv", "role": "user", "content": "bad", "timestamp": now}
        ],
        "deletedConversations": [], "deletedMessages": [],
    })
    assert resp.status_code == 200
    pull_a = client.get("/sync/pull?since=0", headers=headers).json()
    assert pull_a["messages"] == []


def test_deleted_conversation_propagates(client):
    headers = auth_headers(client)
    now = _now()
    client.post("/sync/push", headers=headers, json={
        "conversations": [{"id": "c", "title": "t", "provider": None,
                           "createdAt": now, "updatedAt": now}],
        "messages": [{"id": "m", "chatId": "c", "role": "user", "content": "x", "timestamp": now}],
        "deletedConversations": [], "deletedMessages": [],
    })
    client.post("/sync/push", headers=headers, json={
        "conversations": [], "messages": [],
        "deletedConversations": ["c"], "deletedMessages": [],
    })
    pull = client.get("/sync/pull?since=0", headers=headers).json()
    assert pull["conversations"] == []
    assert pull["messages"] == []


def test_sync_rejects_oversized_content(client):
    headers = auth_headers(client)
    now = _now()
    resp = client.post("/sync/push", headers=headers, json={
        "conversations": [], "messages": [
            {"id": "big", "chatId": "c", "role": "user",
             "content": "x" * 200_001, "timestamp": now}
        ],
        "deletedConversations": [], "deletedMessages": [],
    })
    assert resp.status_code == 422


def test_sync_rejects_too_many_messages(client):
    headers = auth_headers(client)
    now = _now()
    messages = [
        {"id": f"m{i}", "chatId": "c", "role": "user", "content": "x", "timestamp": now}
        for i in range(5001)
    ]
    resp = client.post("/sync/push", headers=headers, json={
        "conversations": [], "messages": messages,
        "deletedConversations": [], "deletedMessages": [],
    })
    assert resp.status_code == 422
