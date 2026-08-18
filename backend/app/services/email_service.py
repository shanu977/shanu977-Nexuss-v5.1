"""Real email delivery for the OTP flow.

Uses the Python standard library (smtplib) so no new dependency is required.
Credentials come exclusively from the backend settings (SMTP_* env vars) and
are never hardcoded, logged, or returned by the API.

The plaintext OTP exists only transiently inside the outbound email message:
it is never logged, never persisted, and never returned by any endpoint.
"""

import logging
import smtplib
import socket
from email.message import EmailMessage
from email.utils import formataddr

from ..config import settings

logger = logging.getLogger("uvicorn.error")

OTP_EMAIL_SUBJECT = "Your password setup verification code"
SMTP_SSL_PORT = 465


class EmailDeliveryError(Exception):
    """Raised when an email cannot be delivered. Never carries secrets."""


class _IPv4SMTP(smtplib.SMTP):
    """smtplib.SMTP that connects over IPv4 only.

    smtp.gmail.com advertises AAAA (IPv6) records ahead of its A records.
    In container runtimes without an IPv6 route (Railway, Docker, Render),
    socket.create_connection tries the first (IPv6) address and raises
    ``[Errno 101] Network is unreachable`` immediately instead of falling
    back to IPv4. Resolving the host to an IPv4 address before connecting
    avoids that, while the hostname is still used for EHLO and STARTTLS
    server-name validation, so certificate checks are unchanged.
    """

    def _get_socket(self, host, port, timeout):
        infos = socket.getaddrinfo(host, port, socket.AF_INET, socket.SOCK_STREAM)
        if not infos:
            raise OSError("No IPv4 address available for %s" % host)
        return socket.create_connection(
            infos[0][4], timeout, self.source_address
        )


class _IPv4SMTP_SSL(smtplib.SMTP_SSL):
    """smtplib.SMTP_SSL variant with the same IPv4-only connection rule."""

    def _get_socket(self, host, port, timeout):
        infos = socket.getaddrinfo(host, port, socket.AF_INET, socket.SOCK_STREAM)
        if not infos:
            raise OSError("No IPv4 address available for %s" % host)
        return socket.create_connection(
            infos[0][4], timeout, self.source_address
        )


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
            server = _IPv4SMTP_SSL(settings.smtp_host, settings.smtp_port, timeout=15)
        else:
            server = _IPv4SMTP(settings.smtp_host, settings.smtp_port, timeout=15)
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
