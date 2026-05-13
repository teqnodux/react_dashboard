# Subscription System — Implementation Plan

> **Status: IMPLEMENTED** — All backend and frontend changes are complete and running.

---

## Core Concept

```
Super Admin
   |
   | manages
   v
Organization / Individual Subscription
   |
   | has many
   v
Users
   |
   | receive/access
   v
Analysis Data + Email Alerts
```

---

## Role Hierarchy

| Role | Scope |
|---|---|
| `super_admin` | Full system access — manages all orgs and users |
| `admin` | Scoped to own organization — manages users within their org |
| `user` | Read-only access to analysis data per their org's plan |
| Individual (`user` + `is_individual: true`) | No org — receives emails only to own address |

---

## 1. MongoDB Collections

### `organizations`
```json
{
  "_id": "ObjectId",
  "name": "string",
  "status": "active | inactive | suspended | expired",
  "plan_name": "basic | pro | enterprise",
  "user_cap": "int — max users allowed",
  "start_date": "datetime",
  "end_date": "datetime",
  "created_by_super_admin_id": "ObjectId",
  "created_at": "datetime",
  "updated_at": "datetime"
}
```

### `users` (updated existing collection)
```json
{
  "organization_id": "string | null (null = individual)",
  "role": "super_admin | admin | user",
  "status": "active | inactive | suspended",
  "is_individual": "bool",
  "force_password_reset": "bool",
  "created_at": "datetime",
  "updated_at": "datetime"
}
```

> **Note:** Users are only created in this collection once they **accept** an invitation.
> Pending/expired invitations live in the `invitations` collection. There is no `invited` status in `users`.

### `organization_email_recipients`
```json
{
  "_id": "ObjectId",
  "organization_id": "string",
  "email": "string",
  "name": "string",
  "is_active": "bool",
  "created_at": "datetime",
  "updated_at": "datetime"
}
```

### `invitations`
```json
{
  "_id": "ObjectId",
  "token": "string (sha256 hash of raw token — NEVER store raw)",
  "email": "string",
  "organization_id": "string",
  "invited_by": "string (user_id)",
  "role": "admin | user",
  "status": "pending | accepted | expired",
  "expires_at": "datetime (48 hours after creation)",
  "created_at": "datetime"
}
```

> **Display in Admin Panel:** `pending` → shown as badge `invited`, `expired` → shown as badge `expired`.
> Expired records are retained for **30 days** (via TTL index) so admins can see and resend them.

### `password_reset_tokens`
```json
{
  "_id": "ObjectId",
  "user_id": "string",
  "token_hash": "string (sha256 of raw token — NEVER store raw)",
  "expires_at": "datetime (1 hour)",
  "used": "bool",
  "created_at": "datetime"
}
```

---

## 2. MongoDB Indexes

Run once via `python migrate_subscription.py`:

```python
db.organizations.create_index("status")
db.organizations.create_index("end_date")
db.users.create_index("email", unique=True)
db.users.create_index("organization_id")
db.invitations.create_index("token", unique=True)
db.invitations.create_index("expires_at", expireAfterSeconds=2592000)  # TTL: delete 30 days after expires_at
db.password_reset_tokens.create_index("expires_at", expireAfterSeconds=0)  # TTL: delete immediately at expiry
db.organization_email_recipients.create_index(
    [("organization_id", 1), ("email", 1)], unique=True
)
```

> **Important:** The invitation TTL is **30 days after `expires_at`** (not 0), so expired invites remain
> visible to admins for review, resending, or removal. Password reset tokens are deleted immediately upon expiry.

---

## 3. Organization Status Lifecycle

### States
- `active` — subscription running, users can access data
- `inactive` — manually deactivated by super_admin
- `suspended` — payment issue or policy violation
- `expired` — `end_date` has passed (auto-set by scheduler)

### Expiry — Two-Layer Approach

**Layer 1: Background scheduler (APScheduler, hourly job)**
Marks all orgs as `expired` where `end_date < now` and `status == active`.

**Layer 2: Lazy check in auth middleware (fallback)**
On every authenticated request for an org user, verify the org is still `active`. If `expired/suspended/inactive`, return `403`.

---

## 4. Password Reset — Two Flows

### Flow 1: Admin-Initiated Reset
Used by a `super_admin` or `admin` to force a user to reset their password.

```
PATCH /api/org/users/{user_id}/force-reset         [admin]
PATCH /api/super-admin/users/{user_id}/force-reset [super_admin]
  → sets user.force_password_reset = true

POST /api/auth/login
  → if force_password_reset is true:
     returns { access: "...", must_reset: true }
  → frontend redirects to /change-password page

POST /api/auth/change-password  { current_password, new_password }
  → validates current_password
  → sets new hash, clears force_password_reset flag
```

### Flow 2: Email-Based Self-Service Reset
```
POST /api/auth/forgot-password  { email }
  → generate token = secrets.token_urlsafe(32)
  → store sha256(token) in password_reset_tokens with 1hr expiry
  → send email: link = https://domain.com/reset-password?token=<raw>
  → always return HTTP 200 (do NOT reveal if email exists)

POST /api/auth/reset-password  { token, new_password }
  → hash incoming token, look up in DB
  → verify: not used, not expired
  → validate password strength (min 8 chars, 1 uppercase, 1 digit)
  → update user password, mark token used=true
```

---

## 5. User Invitation Flow

```
POST /api/org/invite  { email, role: "admin" | "user" }  [admin only]
  → verify org is active
  → check current active user count < org.user_cap
  → guard: no duplicate pending invite or existing user for this email
  → generate invite token (secrets.token_urlsafe), store sha256 hash in invitations
  → send email with link: https://domain.com/accept-invite?token=<raw>

GET /api/auth/invite/check?token=<raw>  [public]
  → pre-validate token before showing the accept form
  → returns: { status: "valid" | "accepted" | "expired" | "invalid" }
  → frontend uses this on page load:
      accepted → redirect to /login with info banner
      expired  → show "Invitation Expired" error page
      invalid  → show "Invalid Invitation" error page
      valid    → show the set-up-account form

POST /api/auth/accept-invite  { token, password, name }
  → validate token not expired/used
  → create user document with organization_id and role from invite
  → mark invitation status = accepted
  → return JWT access + refresh tokens (user is logged in immediately)

POST /api/org/invites/{invite_id}/resend  [admin only]
  → deletes the old invite (pending or expired)
  → creates a fresh invite with new token and 48h TTL
  → sends the invite email again

DELETE /api/org/users/{id}  [admin only]
  → if ID belongs to an invitation (pending or expired): hard-deletes the invite record
  → if ID belongs to a user: sets status=inactive and clears organization_id
```

---

## 6. User Cap Enforcement

Checked before every new invite within an org:

```python
def check_user_cap(org_id: str, db):
    org = get_org_or_404(org_id, db)
    current_count = db["users"].count_documents({
        "organization_id": org_id,
        "status": {"$in": ["active", "suspended"]},
    })
    if current_count >= org["user_cap"]:
        raise HTTPException(403, f"User cap of {org['user_cap']} reached")
```

> Pending/expired invitations are **not** counted toward the cap — only users who have accepted
> and exist in the `users` collection count.

---

## 7. JWT Token Payload

```python
token_payload = {
    "user_id": str(user["_id"]),
    "email": user["email"],
    "role": user.get("role", "user"),           # super_admin | admin | user
    "org_id": str(user["organization_id"]) if user.get("organization_id") else None,
    "is_individual": user.get("is_individual", False),
    "force_reset": user.get("force_password_reset", False),
}
```

Login response also includes `org_id`, `is_individual`, `must_reset` so the frontend can act immediately without a second request.

---

## 8. API Routes

### Super Admin (`/api/super-admin/...`)
```
POST   /orgs                           → create organization
GET    /orgs                           → list all orgs (with ?status= filter)
PATCH  /orgs/{id}                      → update plan, status, dates, user_cap
DELETE /orgs/{id}                      → soft-delete (set status=inactive)
GET    /orgs/{id}/users                → list all users in a specific org
GET    /users                          → list all users system-wide
POST   /users                          → create user directly (force_password_reset=true)
PATCH  /users/{id}                     → change role, status, org assignment
PATCH  /users/{id}/force-reset         → set force_password_reset flag
```

### Org Admin (`/api/org/...`) — scoped to admin's own org
```
GET    /users                          → list users + pending/expired invitations combined
POST   /invite                         → invite user by email (checks user_cap)
POST   /invites/{id}/resend            → resend a pending or expired invite
PATCH  /users/{id}/suspend             → suspend user (cannot self-suspend)
PATCH  /users/{id}/reactivate          → reactivate suspended/inactive user
PATCH  /users/{id}/force-reset         → force password reset (cannot self-reset)
DELETE /users/{id}                     → remove user OR cancel/remove invite (cannot self-remove)
GET    /email-recipients               → list email recipients
POST   /email-recipients               → add recipient
PATCH  /email-recipients/{id}          → update recipient (name, is_active)
DELETE /email-recipients/{id}          → remove recipient
```

### Auth (`/api/auth/...`)
```
POST   /login                          → existing (returns org_id, is_individual, must_reset)
POST   /token/refresh                  → existing (updated payload)
POST   /forgot-password                → send password reset email
POST   /reset-password                 → set new password via token
POST   /change-password                → change password (authenticated, for force-reset flow)
POST   /accept-invite                  → accept invitation, create user, return JWT
GET    /invite/check                   → pre-validate invite token (public)
```

---

## 9. Admin Panel — User List Behaviour

The `GET /api/org/users` endpoint returns a **combined list** of:
- All users in the org (from `users` collection)
- All `pending` invitations → displayed with status badge `invited`
- All `expired` invitations → displayed with status badge `expired`

The **currently logged-in admin is filtered out** of the list (cannot self-manage).

### Action Buttons per Status

| Status | Available Actions |
|---|---|
| `active` | Suspend, Force Reset, Remove |
| `suspended` | Reactivate, Force Reset, Remove |
| `inactive` | Reactivate, Force Reset, Remove |
| `invited` (pending invite) | Cancel Invite |
| `expired` (expired invite) | Resend Invite, Remove |

---

## 10. Email Recipients — Dispatch Logic

For analysis emails:
- **Org users** → send to all active addresses in `organization_email_recipients` for their org
- **Individual users** → send only to their own `users.email`

```python
def get_email_targets(user: dict, db) -> list[str]:
    if user.get("is_individual"):
        return [user["email"]]
    org_id = user.get("organization_id")
    if not org_id:
        return []
    recipients = db["organization_email_recipients"].find({
        "organization_id": org_id,
        "is_active": True
    })
    return [r["email"] for r in recipients]
```

---

## 11. File Structure

```
backend/
├── main.py                      existing routes + new router includes + middleware + scheduler
├── auth.py                      build_token_payload, require_roles, require_super_admin, etc.
├── config.py                    environment variable loading
├── db.py                        centralized MongoDB client (get_db, collection accessors)
├── migrate_subscription.py      one-time migration: update users, create indexes
├── routers/
│   ├── __init__.py
│   ├── super_admin.py           org + user management for super_admin
│   ├── org_admin.py             scoped org management for admin
│   └── auth_extended.py         forgot-pw, reset-pw, accept-invite, change-pw, invite/check
└── services/
    ├── __init__.py
    ├── email_service.py         console / SendGrid / SMTP provider, invite + reset templates
    ├── org_service.py           org lifecycle helpers, user_cap check, expiry scheduler job
    └── invite_service.py        token generation (sha256), validate_invite, mark_invite_accepted

frontend/src/
├── context/AuthContext.tsx      User type includes org_id, is_individual; login returns must_reset
├── hooks/usePermissions.ts      isSuperAdmin, isAdmin helpers
├── config/roleConfig.ts         super_admin added to Role type + ROLE_CONFIG
├── services/
│   ├── api.ts                   Axios instance — AUTH_PASSTHROUGH_PATHS bypass token refresh
│   └── adminApi.ts              orgAdminApi, superAdminApi, authApi typed helpers
├── pages/
│   ├── Login.tsx                must_reset redirect, forgot-password link, invite info banner
│   ├── auth/
│   │   ├── ForgotPassword.tsx
│   │   ├── ResetPassword.tsx
│   │   ├── AcceptInvite.tsx     pre-validates token on mount (accepted/expired/invalid states)
│   │   └── ChangePassword.tsx
│   └── admin/
│       ├── AdminPanel.tsx       users + invitations list, email recipients tab
│       └── SuperAdminPanel.tsx  orgs tab, all-users tab, create user modal
├── styles/AdminNav.css          dark-theme admin styles with CSS variables
└── App.tsx                      routes: /forgot-password, /reset-password, /accept-invite,
                                          /change-password, /admin (RoleGuard), /super-admin (RoleGuard)
```

---

## 12. Migration Script

Run **once** before deploying, and re-run if indexes need updating:

```bash
cd backend
python migrate_subscription.py
```

Script steps:
1. Updates existing `admin` users → `role=admin, status=active, is_individual=False`
2. Updates existing `user/viewer` users → `role=user, status=active, is_individual=True`
3. Creates all required MongoDB indexes (drops and recreates TTL indexes safely)
4. Prints instructions for manually promoting the first `super_admin`

---

## 13. Production Checklist

| Concern | Status | Action |
|---|---|---|
| Email sending | Pending | Configure `EMAIL_PROVIDER=sendgrid` or `smtp` in `.env` |
| Token security | Done | All reset/invite tokens are sha256-hashed before DB storage |
| Org expiry | Done | APScheduler hourly job + lazy middleware check |
| Password strength | Done | Min 8 chars, 1 uppercase, 1 digit — enforced server-side |
| Self-action guards | Done | Admins cannot suspend/remove/force-reset themselves |
| Rate limiting | Done | `slowapi` on `/login` and `/forgot-password` |
| Individual users | Done | Bypass org checks via `is_individual=True` flag |
| DB connection | Done | Centralized in `db.py` |
| SPA routing | Done | `_redirects` file for Render static hosting |
| Audit log | Pending | Add `audit_log` collection for who changed what, when |
| Soft deletes | Done | Users are set `status=inactive`; orgs are set `status=inactive` |
| Invite retention | Done | Expired invites kept 30 days (TTL) so admins can resend/review |
