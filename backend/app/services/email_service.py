"""Real email delivery for the OTP flow.

Uses the Python standard library (smtplib) so no new dependency is required.
Credentials come exclusively from the backend settings (SMTP_* env vars) and
are never hardcoded, logged, or returned by the API.

The plaintext OTP exists only transiently inside the outbound email message:
it is never logged, never persisted, and never returned by any endpoint.
"""

import logging
import smtplib
from email.message import EmailMessage
from email.utils import formataddr

from ..config import settings

logger = logging.getLogger("uvicorn.error")

OTP_EMAIL_SUBJECT = "Your password setup verification code"
SMTP_SSL_PORT = 465


class EmailDeliveryError(Exception):
    """Raised when an email cannot be delivered. Never carries secrets."""


def _message(to_email: str, subject: str, body: str) -> EmailMessage:
    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = formataddr((settings.smtp_from_name, settings.smtp_from_email))
    message["To"] = to_email
    message.set_content(body)
    return message


def build_otp_message(to_email: str, otp_code: str) -> EmailMessage:
    body = (
        "Your verification code is:\n\n"
        f"{otp_code}\n\n"
        "This code expires in 10 minutes.\n\n"
        "If you did not request this, ignore this email."
    )
    return _message(to_email, OTP_EMAIL_SUBJECT, body)


def _deliver(message: EmailMessage, to_email: str) -> None:
    """Send `message` over SMTP. Raises EmailDeliveryError on any failure."""
    if not settings.smtp_host or not settings.smtp_from_email:
        raise EmailDeliveryError("Email delivery is not configured.")

    try:
        if settings.smtp_port == SMTP_SSL_PORT:
            server = smtplib.SMTP_SSL(settings.smtp_host, settings.smtp_port, timeout=15)
        else:
            server = smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=15)
        with server:
            server.ehlo()
            if settings.smtp_port != SMTP_SSL_PORT:
                server.starttls()
                server.ehlo()
            if settings.smtp_username:
                server.login(settings.smtp_username, settings.smtp_password)
            server.send_message(message)
    except (smtplib.SMTPException, OSError, ValueError) as exc:
        # Safe diagnostic information only: recipient, host, port and the
        # SMTP server's own message. The password is never logged.
        logger.warning(
            "SMTP delivery failed for %s via %s:%s: %s",
            to_email,
            settings.smtp_host,
            settings.smtp_port,
            exc,
        )
        raise EmailDeliveryError("Email delivery failed.") from exc


def send_email(to_email: str, subject: str, body: str) -> None:
    """Send a plain-text email."""
    _deliver(_message(to_email, subject, body), to_email)


def send_otp_email(to_email: str, otp_code: str) -> None:
    """Deliver an OTP verification code by email."""
    _deliver(build_otp_message(to_email, otp_code), to_email)
