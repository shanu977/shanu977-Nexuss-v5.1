from pydantic import BaseModel


class AccountInfoOut(BaseModel):
    """Non-sensitive profile facts shown on the Settings › Account tab."""

    email: str
    name: str
    photo_url: str | None = None
    provider: str
    role: str
    # Account provisioning timestamp (ms since epoch) from the `users` row.
    created_at: int


class DeleteAccountIn(BaseModel):
    """Body for the self-service account deletion endpoint.

    ``confirmation`` must be the exact literal ``DELETE`` — validated
    server-side so a mis-wired client can never trigger destruction. No user
    identifier is accepted here: the account to delete always comes from the
    verified Firebase ID token.
    """

    confirmation: str = ""

    model_config = {"extra": "forbid"}


class DeletionStatusOut(BaseModel):
    """Public view of the deletion job.

    ``state`` is one of:
      * ``none``        — no deletion has been requested
      * ``queued``      — accepted, waiting to start
      * ``running``     — a worker is deleting right now
      * ``retry_wait``  — a step failed; a bounded automatic retry is scheduled
      * ``failed``      — the retry budget was exhausted (manual retry allowed)
      * ``completed``   — deletion finished and was verified (job row removed)

    Only progress information is exposed — no internal identifiers, emails,
    stack traces, or infrastructure details.
    """

    state: str
    stage: str | None = None
    attempt: int = 0
    next_attempt_at: int | None = None
    last_error: str | None = None
    detail: str | None = None


class DeleteAccountOut(DeletionStatusOut):
    """Result of ``POST /account/delete`` (an accepted deletion job)."""
