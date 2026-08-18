"""Email delivery for the OTP flow.

Two delivery paths, selected by configuration:

* Resend (HTTPS API) — used when ``RESEND_API_KEY`` is set. HTTPS egress is
  available on every Railway plan, so this path works even where outbound SMTP
  is blocked (free/Hobby plans block SMTP ports 25/465/587/2525).
* SMTP (standard library smtplib) — fallback used when no Resend key is set.

Credentials come exclusively from the backend settings (RESEND_* / SMTP_* env
vars) and are never hardcoded, logged, or returned by the API.

The plaintext OTP exists only transiently inside the outbound email message:
it is never logged, never persisted, and never returned by any endpoint.
"""

import json
import logging
import smtplib
import socket
import urllib.error
import urllib.request
from email.message import EmailMessage
from email.utils import formataddr

from ..config import settings

logger = logging.getLogger("uvicorn.error")

OTP_EMAIL_SUBJECT = "Your password setup verification code"
SMTP_SSL_PORT = 465
RESEND_API_URL = "https://api.resend.com/emails"


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


def _deliver_resend(message: EmailMessage, to_email: str) -> None:
    """Deliver `message` over HTTPS via the Resend API.

    Raises EmailDeliveryError on any failure; the API key is never logged.
    """
    if not settings.resend_api_key or not settings.resend_from_email:
        raise EmailDeliveryError("Email delivery is not configured.")

    payload = {
        "from": formataddr((settings.resend_from_name, settings.resend_from_email)),
        "to": [to_email],
        "subject": message["Subject"],
        "text": message.get_content(),
    }
    req = urllib.request.Request(
        RESEND_API_URL,
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={
            "Authorization": "Bearer %s" % settings.resend_api_key,
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            if resp.status != 200:
                raise EmailDeliveryError(
                    "Email API returned status %s" % resp.status
                )
    except urllib.error.HTTPError as exc:
        # Safe diagnostics only: status code and (shortened) provider message.
        # The API key is sent in the Authorization header and never logged.
        logger.warning(
            "Email API delivery failed for %s: HTTP %s",
            to_email,
            exc.code,
        )
        raise EmailDeliveryError("Email delivery failed.") from exc
    except (OSError, ValueError) as exc:
        logger.warning("Email API delivery failed for %s: %s", to_email, exc)
        raise EmailDeliveryError("Email delivery failed.") from exc


def _deliver(message: EmailMessage, to_email: str) -> None:
    """Send `message`. Raises EmailDeliveryError on any failure.

    Prefers Resend (HTTPS) when RESEND_API_KEY is set, then falls back to the
    SMTP path. SMTP is disabled on Railway free/Hobby plans, so the HTTPS path
    is the production delivery route.
    """
    if settings.resend_api_key:
        _deliver_resend(message, to_email)
        return

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
