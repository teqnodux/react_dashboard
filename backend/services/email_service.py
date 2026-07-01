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
    subject = f"You've been invited to join {org_name}"
    body = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Invitation to Join Analysis Dashboard</title>
</head>
<body style="margin:0; padding:0; background-color:#f4f6f8; font-family:Arial, Helvetica, sans-serif; color:#111827;">
  <div style="display:none; max-height:0; overflow:hidden; opacity:0; color:transparent;">
    You have been invited to join {org_name} on the Analysis Dashboard.
  </div>
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background-color:#f4f6f8; padding:24px 0;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width:600px; background-color:#ffffff; border-radius:10px; overflow:hidden; border:1px solid #e5e7eb;">
          <tr>
            <td style="padding:24px 32px; background-color:#111827; color:#ffffff;">
              <h1 style="margin:0; font-size:22px; font-weight:600;">ArbIntel Dashboard</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              <h2 style="margin:0 0 16px; font-size:20px; font-weight:600; color:#111827;">
                You're invited to join {org_name}
              </h2>
              <p style="margin:0 0 16px; font-size:15px; line-height:1.6; color:#374151;">
                You have been invited to access <strong>{org_name}</strong> on the Analysis Dashboard.
              </p>
              <p style="margin:0 0 24px; font-size:15px; line-height:1.6; color:#374151;">
                Click the button below to accept the invitation and set up your account.
              </p>
              <table cellpadding="0" cellspacing="0" role="presentation" style="margin:0 0 24px;">
                <tr>
                  <td align="center" bgcolor="#2563eb" style="border-radius:6px;">
                    <a href="{invite_link}" target="_blank"
                       style="display:inline-block; padding:12px 22px; font-size:15px; font-weight:600; color:#ffffff; text-decoration:none; border-radius:6px;">
                      Accept Invitation
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin:0 0 16px; font-size:14px; line-height:1.6; color:#4b5563;">
                This invitation link will expire in <strong>48 hours</strong>.
              </p>
              <p style="margin:0 0 8px; font-size:14px; line-height:1.6; color:#4b5563;">
                If the button does not work, copy and paste this link into your browser:
              </p>
              <p style="margin:0 0 24px; font-size:13px; line-height:1.6; word-break:break-all;">
                <a href="{invite_link}" target="_blank" style="color:#2563eb; text-decoration:underline;">
                  {invite_link}
                </a>
              </p>
              <p style="margin:0; font-size:14px; line-height:1.6; color:#6b7280;">
                If you were not expecting this invitation, you can safely ignore this email.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 32px; background-color:#f9fafb; border-top:1px solid #e5e7eb;">
              <p style="margin:0; font-size:12px; line-height:1.6; color:#6b7280;">
                This is an automated email from Analysis Dashboard. Please do not reply to this message.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>"""
    return send_email(to_email, subject, body)


def send_password_reset_email(
    to_email: str,
    reset_link: str,
    admin_initiated: bool = False,
) -> bool:
    subject = "Reset your password — Analysis Dashboard"
    intro = (
        "Your administrator has requested a password reset for your account."
        if admin_initiated
        else "A password reset was requested for your account."
    )
    footer_note = (
        "If you were not expecting this, please contact your administrator."
        if admin_initiated
        else "If you did not request this, you can safely ignore this email."
    )
    body = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Reset your password</title>
</head>
<body style="margin:0; padding:0; background-color:#f4f6f8; font-family:Arial, Helvetica, sans-serif; color:#111827;">
  <div style="display:none; max-height:0; overflow:hidden; opacity:0; color:transparent;">
    {intro}
  </div>
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background-color:#f4f6f8; padding:24px 0;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width:600px; background-color:#ffffff; border-radius:10px; overflow:hidden; border:1px solid #e5e7eb;">
          <tr>
            <td style="padding:24px 32px; background-color:#111827; color:#ffffff;">
              <h1 style="margin:0; font-size:22px; font-weight:600;">Analysis Dashboard</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              <h2 style="margin:0 0 16px; font-size:20px; font-weight:600; color:#111827;">
                Reset your password
              </h2>
              <p style="margin:0 0 24px; font-size:15px; line-height:1.6; color:#374151;">
                {intro}
              </p>
              <table cellpadding="0" cellspacing="0" role="presentation" style="margin:0 0 24px;">
                <tr>
                  <td align="center" bgcolor="#2563eb" style="border-radius:6px;">
                    <a href="{reset_link}" target="_blank"
                       style="display:inline-block; padding:12px 22px; font-size:15px; font-weight:600; color:#ffffff; text-decoration:none; border-radius:6px;">
                      Reset Password
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin:0 0 16px; font-size:14px; line-height:1.6; color:#4b5563;">
                This link will expire in <strong>1 hour</strong>.
              </p>
              <p style="margin:0 0 8px; font-size:14px; line-height:1.6; color:#4b5563;">
                If the button does not work, copy and paste this link into your browser:
              </p>
              <p style="margin:0 0 24px; font-size:13px; line-height:1.6; word-break:break-all;">
                <a href="{reset_link}" target="_blank" style="color:#2563eb; text-decoration:underline;">
                  {reset_link}
                </a>
              </p>
              <p style="margin:0; font-size:14px; line-height:1.6; color:#6b7280;">
                {footer_note}
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 32px; background-color:#f9fafb; border-top:1px solid #e5e7eb;">
              <p style="margin:0; font-size:12px; line-height:1.6; color:#6b7280;">
                This is an automated email from Analysis Dashboard. Please do not reply to this message.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>"""
    return send_email(to_email, subject, body)


def send_analysis_email(recipients: list[str], subject: str, html_body: str) -> bool:
    return send_email(recipients, subject, html_body)
