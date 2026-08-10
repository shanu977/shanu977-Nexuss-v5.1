from typing import Dict, List

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Message

MEMORY_LIMIT = 20


def get_recent_messages(
    db: Session,
    conversation_id: str,
    limit: int = MEMORY_LIMIT,
    exclude_id: str | None = None,
) -> List[Dict[str, str]]:
    """Load the last `limit` messages for a conversation, oldest -> newest.

    Uses the existing messages table (no vector store). Returns dicts in the
    OpenAI-style {role, content} shape for direct use by the AI provider.
    Optionally excludes a message id (e.g. the message just saved); the
    exclusion is applied in SQL so the returned count is exactly `limit`.
    Ordering is deterministic via (created_at, id).
    """
    query = select(Message).where(Message.conversation_id == conversation_id)
    if exclude_id:
        query = query.where(Message.id != exclude_id)
    query = query.order_by(Message.created_at.desc(), Message.id.desc()).limit(limit)

    rows = db.scalars(query).all()

    return [
        {"role": row.role, "content": row.content}
        for row in reversed(rows)
    ]
