"""
Email service wrapper.

Set EMAIL_PROVIDER in .env to "sendgrid" or "smtp".
Required env vars per provider:

  SendGrid:
    EMAIL_PROVIDER=sendgrid
    SENDGRID_API_KEY=SG.xxx
    EMAIL_FROM=noreply@yourdomain.com

  SMTP (Gmail / custom):
    EMAIL_PROVIDER=smtp
    SMTP_HOST=smtp.gmail.com
    SMTP_PORT=587
    SMTP_USER=you@gmail.com
    SMTP_PASSWORD=app-password
    EMAIL_FROM=you@gmail.com

If neither is configured, emails are printed to the console (dev mode).
"""

import os
import smtplib
import logging
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

logger = logging.getLogger(__name__)

EMAIL_PROVIDER = os.getenv("EMAIL_PROVIDER", "console")
EMAIL_FROM = os.getenv("EMAIL_FROM", "noreply@example.com")


def send_email(to: str | list[str], subject: str, html_body: str) -> bool:
    """
    Send an email. Returns True on success, False on failure.
    `to` can be a single address string or a list of addresses.
    """
    recipients = [to] if isinstance(to, str) else to

    if EMAIL_PROVIDER == "sendgrid":
        return _send_sendgrid(recipients, subject, html_body)
    elif EMAIL_PROVIDER == "smtp":
        return _send_smtp(recipients, subject, html_body)
    else:
        # Console mode — log email instead of sending
        logger.info(
            "[EMAIL CONSOLE] To: %s | Subject: %s\n%s",
            ", ".join(recipients), subject, html_body,
        )
        return True


def _send_sendgrid(recipients: list[str], subject: str, html_body: str) -> bool:
    try:
        import sendgrid
        from sendgrid.helpers.mail import Mail, To

        api_key = os.getenv("SENDGRID_API_KEY", "")
        sg = sendgrid.SendGridAPIClient(api_key=api_key)
        message = Mail(
            from_email=EMAIL_FROM,
            to_emails=[To(r) for r in recipients],
            subject=subject,
            html_content=html_body,
        )
        response = sg.send(message)
        return response.status_code in (200, 202)
    except Exception as e:
        logger.error("SendGrid error: %s", e)
        return False


def _send_smtp(recipients: list[str], subject: str, html_body: str) -> bool:
    try:
        host = os.getenv("SMTP_HOST", "smtp.gmail.com")
        port = int(os.getenv("SMTP_PORT", "587"))
        user = os.getenv("SMTP_USER", "")
        password = os.getenv("SMTP_PASSWORD", "")

        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = EMAIL_FROM
        msg["To"] = ", ".join(recipients)
        msg.attach(MIMEText(html_body, "html"))

        with smtplib.SMTP(host, port) as server:
            server.starttls()
            server.login(user, password)
            server.sendmail(EMAIL_FROM, recipients, msg.as_string())
        return True
    except Exception as e:
        logger.error("SMTP error: %s", e)
        return False


# ── Template helpers ──────────────────────────────────────────────────────────

def send_invite_email(to_email: str, org_name: str, invite_link: str) -> bool:
    subject = f"You've been invited to {org_name}"
    body = f"""
    <p>You have been invited to join <strong>{org_name}</strong> on the Analysis Dashboard.</p>
    <p><a href="{invite_link}" style="padding:10px 20px;background:#2563eb;color:#fff;border-radius:5px;text-decoration:none;">
       Accept Invitation
    </a></p>
    <p>This link expires in 48 hours.</p>
    """
    return send_email(to_email, subject, body)


def send_password_reset_email(to_email: str, reset_link: str) -> bool:
    subject = "Reset your password"
    body = f"""
    <p>A password reset was requested for your account.</p>
    <p><a href="{reset_link}" style="padding:10px 20px;background:#2563eb;color:#fff;border-radius:5px;text-decoration:none;">
       Reset Password
    </a></p>
    <p>This link expires in 1 hour. If you didn't request this, you can safely ignore this email.</p>
    """
    return send_email(to_email, subject, body)


def send_analysis_email(recipients: list[str], subject: str, html_body: str) -> bool:
    return send_email(recipients, subject, html_body)
