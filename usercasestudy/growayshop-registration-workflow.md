# Store Module — Account Creation Workflow

**Architecture:** see `groway-v1-architecture.md` for the shared Gateway, one Postgres instance (this module owns the `store` schema), one Redis (sessions tagged `population: "store"`), the `StoreSession` authentication scheme, route-group fail-closed enforcement (`/api/store/*`), and the compiler-enforced module-boundary/extraction pattern (`IStoreUserService` in `Groway.Store.Contracts`). Not re-derived here.

**Relationship to other documents:**
- `store-onboarding-v1-design.md` is treated as **fixed reference, not modified this round**. Its data model (`stores`, `staff`, `services`, etc.) is implemented by **this same Store Module**, in the **same `store` schema** as everything in this document — real foreign keys within the schema, not a cross-service or cross-schema reference (architecture doc §5).
- `growayadmin-registration-workflow.md`: a Groway admin is the *actor* who can create the initial store-front account(s); the call reaches this module **in-process** (§3), not over the network.
- `growayshop-staff-invite-workflow.md`: covers the *ongoing* "invite a staff member" flow (by either a Groway admin or a `store_admin`, at any time) — this document covers only the *initial* batch created during onboarding.

**Scope — deliberately narrow.** How a Groway admin creates the initial store-front login account(s) for a newly onboarded store, plus the baseline login/session/password-reset mechanics. Out of scope: ongoing staff invitation (`growayshop-staff-invite-workflow.md`); any dashboard/calendar/booking feature API.

---

## 1. Two app roles — decoupled from the business-role label already in `staff`

`store-onboarding-v1-design.md`'s `staff.role` (`owner`/`manager`/`staff`, or free text like "CEO") is **descriptive**, not access-control. This document's **app role**, chosen by whoever creates the account, is separate:

| | `store_admin` | `staff` |
|---|---|---|
| App access | Higher | Lower |
| Sees the store's whole calendar | Yes | Yes |
| Can make/manage bookings | *(future feature)* | **No** |
| Can request their own time off | *(future feature)* | Yes — feeds `staff_time_offs` |
| Can invite additional `staff` accounts | Yes — `growayshop-staff-invite-workflow.md` | No |
| Number of stores accessible | Exactly one (own store). Exception: the Chain owner (billing_account holder) sees all Chain stores | One or many, switchable (§6) |
| Who creates this account | Groway admin (this document) or ongoing via `growayshop-staff-invite-workflow.md` | Groway admin (this document, initial batch) or a `store_admin` (`growayshop-staff-invite-workflow.md`) |
| Password reset | Self-service, like a customer | Self-service, like a customer |

Each `store.store_users` row has exactly one `app_role` — a person needing different roles at different stores needs two separate accounts (§8 item 1). A `store_admin` can **never** create another `store_admin` through any flow in this system — one admin per store in this version. (Adding a store to an existing Chain is done by the Chain owner or a Groway admin, and reuses the Chain's existing `billing_account` — see §6.1.)

---

## 2. Store access and store-switching

**One store, one operational admin.** A `store_admin` account is tied to exactly one store — enforced at the database level (`store.stores.store_admin_id UNIQUE`, §5). There is exactly one exception:

- **The Chain owner** — the `store_admin` referenced by `billing_accounts.store_admin_id` (usually the first store's admin) — gets a cross-store view over every store in the Chain, plus billing management. This reuses the same `store.store_user_store_access` many-to-many rows (§5); it is the *only* `store_admin` account that may hold more than one.

`staff` accounts are unaffected: a staff member may still work at one or many stores of the same Chain (e.g. Anna picking up shifts at two branches), via `store.store_user_store_access` — never across unrelated companies.

The session tracks **one active store at a time** (§4); switching (§6.5) updates context within the existing session, it never re-authenticates. For a regular `store_admin` there is only one store to be active on, so switching is effectively a no-op for them.

---

## 3. Why creating this account is an in-process call, not a network call

A Groway admin's session is tagged `population:"admin"` in the shared Redis (architecture doc §6.5); the `StoreSession` authentication scheme would reject it outright on any `/api/store/*` route. So a Groway admin never calls a Store Module route directly — they call an **Admin Module** endpoint, which invokes Store Module's public interface **in-process**:

```mermaid
sequenceDiagram
    actor GA as Groway admin
    participant GW as Gateway
    participant AM as Admin Module
    participant SM as Store Module (IStoreUserService)

    GA->>GW: POST /api/admin/store-users<br/>{ storeAccess:[{storeId, staffId}], appRole, email? }<br/>(AdminSession)
    GW->>AM: (AdminSession validated)
    AM->>SM: IStoreUserService.CreateStoreUserAsync(request, callerContext)<br/>(in-process call across the Groway.Store.Contracts boundary)
    SM-->>AM: CreateStoreUserResult { storeUserId }
    AM-->>GA: 201 Created
```

`callerContext.Population == "admin"` here — Store Module's implementation still checks this explicitly (never assumes "Admin Module already authorized it," per architecture doc §6.5) before proceeding to §5.1's logic. This is the extraction seam: if Store Module is ever pulled out into its own service, this becomes an HTTP call with the same `CreateStoreUserRequest`/`CallerContext` shape — Admin Module's code does not change.

---

## 4. Session mechanism

Shared Redis, `population:"store"`, per architecture doc §7. The store-specific addition is `activeStoreId`:

```json
{
  "sessionId": "...", "population": "store",
  "principalId": "...", "appRole": "store_admin",
  "activeStoreId": "...",
  "cognitoAccessToken": "...", "cognitoIdToken": "...", "cognitoRefreshToken": "...",
  "createdAt": "...", "lastUsedAt": "...", "expiresAt": "..."
}
```

---

## 5. Database schema (`store` schema, `StoreDbContext`)

```sql
-- One row per store-front login account (either app role).
CREATE TABLE store.store_users (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cognito_sub         VARCHAR(64)  NOT NULL UNIQUE,   -- Cognito "sub" in the Store User Pool
    email               VARCHAR(255) NOT NULL UNIQUE,
    display_name        VARCHAR(200),
    app_role            VARCHAR(20)  NOT NULL CHECK (app_role IN ('store_admin', 'staff')),
    -- No staff_id here - which roster row this account corresponds to is a
    -- per-store fact (see store_user_store_access below), since the
    -- same login can map to a different staff row at each branch it works.
    status              VARCHAR(20)  NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deactivated')),
    -- Exactly one of the next two is set: who created this account. A Groway
    -- admin (admin.admins.id, cross-schema - no enforced FK per architecture
    -- doc §5) or another store_users row (store_admin invited them).
    created_by_admin_id      UUID,
    created_by_store_user_id UUID REFERENCES store.store_users(id),
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
    last_login_at       TIMESTAMPTZ,
    CONSTRAINT chk_exactly_one_creator CHECK (
        (created_by_admin_id IS NOT NULL) <> (created_by_store_user_id IS NOT NULL)
    )
);

-- Many-to-many: which stores a store_user can access.
-- store_id/staff_id are REAL foreign keys - stores/staff live in this
-- same `store` schema (store-onboarding-v1-design.md's tables).
CREATE TABLE store.store_user_store_access (
    store_user_id       UUID NOT NULL REFERENCES store.store_users(id),
    store_id         UUID NOT NULL REFERENCES store.stores(id),
    staff_id            UUID REFERENCES store.staff(id),  -- the roster row for THIS store.
                                          -- NULL for a store_admin with no service-performing role there.
    is_primary          BOOLEAN NOT NULL DEFAULT FALSE,  -- default activeStoreId after login
    granted_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    granted_by_admin_id       UUID,  -- cross-schema reference to admin.admins.id, not enforced
    granted_by_store_user_id  UUID REFERENCES store.store_users(id),
    PRIMARY KEY (store_user_id, store_id),
    CONSTRAINT chk_exactly_one_granter CHECK (
        (granted_by_admin_id IS NOT NULL) <> (granted_by_store_user_id IS NOT NULL)
    )
);

CREATE TABLE store.store_user_activity_log (
    id             BIGSERIAL PRIMARY KEY,
    store_user_id  UUID REFERENCES store.store_users(id),
    event_type     VARCHAR(30) NOT NULL,
    event_detail   JSONB,
    ip_address     VARCHAR(45),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_store_user_event_type CHECK (event_type IN (
        'ACCOUNT_CREATED', 'INVITE_ACCEPTED',
        'LOGIN_SUCCESS', 'LOGIN_FAILED', 'LOGOUT',
        'PASSWORD_RESET_REQUESTED', 'PASSWORD_RESET_COMPLETED',
        'STORE_SWITCHED'
    ))
);

CREATE INDEX idx_store_user_store_access_store ON store.store_user_store_access(store_id);

**Amendment (2026-09-28) — one store, one operational admin.** `store.stores` gains a new column, DB-enforcing that each store has exactly one operational `store_admin`:

```sql
-- One operational admin per store, DB-enforced (2026-09-28 decision).
-- The Chain owner's cross-store rows in store_user_store_access are unaffected.
ALTER TABLE store.stores
    ADD COLUMN store_admin_id UUID UNIQUE REFERENCES store.store_users(id);
```

(The `stores` table itself is defined in `store-onboarding-v1-design.md`, which needs the same amendment — that document is a fixed reference and is updated separately.)
CREATE INDEX idx_store_user_activity_log_store_user_id ON store.store_user_activity_log(store_user_id);
```

Activity log delivery: dedicated `store-activity-log` SQS queue + its own KEDA-scaled consumer, per architecture doc §8 — a third, independent queue, unaffected by everything else being consolidated.

---

## 6. Sequence diagrams

### 6.1 Account creation (continuing from §3)

```mermaid
sequenceDiagram
    participant SM as Store Module (IStoreUserService)
    participant SCOG as Amazon Cognito (Store User Pool)
    participant DB as PostgreSQL (store schema)
    participant SQSQ as SQS (store-activity-log)

    Note over SM: entry: CreateStoreUserAsync(request, callerContext), §3
    SM->>SCOG: AdminCreateUser(Username=email, UserAttributes=[email], DesiredDeliveryMediums=['EMAIL'])
    SCOG-->>SCOG: Create user (FORCE_CHANGE_PASSWORD), auto-generate + email temp password
    SCOG-->>SM: 200 OK { sub }
    SM->>DB: INSERT INTO store.store_users (cognito_sub, email, app_role, created_by_admin_id, status='active')
    alt appRole == 'store_admin' AND this is a brand-new Chain (no billing_account exists yet)
        SM->>DB: INSERT INTO store.billing_accounts<br/>(store_admin_id, plan='free')
        Note over SM,DB: This admin becomes the Chain owner. See groway-billing-workflow.md - every store<br/>created under this Chain gets this billing_account_id.<br/>Free is permanent by default; no expiry is set here.
    else appRole == 'store_admin' AND the Chain already has a billing_account (adding another store)
        SM->>DB: (no new billing_account) reuse the Chain's existing billing_account_id
        Note over SM,DB: One Chain, one billing_account, one shared 100/month quota -<br/>never one per store_admin.
    end
    loop for each { storeId, staffId } in storeAccess
        SM->>DB: INSERT INTO store.store_user_store_access (store_user_id, store_id, staff_id, is_primary)
        SM->>DB: UPDATE store.stores SET billing_account_id = <the Chain's billing_account_id>,<br/>store_admin_id = <the new store_user id> WHERE id = storeId
    end
    SM->>SQSQ: SendMessage { event_type:'ACCOUNT_CREATED', store_user_id, ... }
    SM-->>SM: return CreateStoreUserResult { storeUserId }
```

The `email` for `AdminCreateUser` comes from `store.staff.email` if the roster already has one for that person; the caller can override it if the intake email didn't include one.

### 6.2 Accepting the invite / first login (forced password change)

```mermaid
sequenceDiagram
    actor N as Newly created store user (either app role)
    participant GW as Gateway
    participant SM as Store Module
    participant SCOG as Amazon Cognito
    participant REDIS as Redis
    participant DB as PostgreSQL (store schema)
    participant SQSQ as SQS (store-activity-log)

    N->>GW: POST /api/store/auth/login { email, password=<temp password> }
    GW->>SM: (in-process)
    SM->>SCOG: InitiateAuth(USER_PASSWORD_AUTH, Username=email, Password, SecretHash)
    SCOG-->>SM: ChallengeName=NEW_PASSWORD_REQUIRED, Session
    SM-->>N: 200 OK { challengeRequired:true }

    N->>GW: POST /api/store/auth/login/new-password { newPassword, cognitoSession }
    GW->>SM: (in-process)
    SM->>SCOG: RespondToAuthChallenge(NEW_PASSWORD_REQUIRED, newPassword, Session, SecretHash)
    SCOG-->>SM: { AccessToken, IdToken, RefreshToken }
    SM->>DB: SELECT store_id FROM store.store_user_store_access<br/>WHERE store_user_id=... ORDER BY is_primary DESC LIMIT 1
    SM->>REDIS: SET session:<hash(opaque_token)> (population:'store', storeUserId, appRole, activeStoreId, cognito tokens, TTL)
    SM->>SQSQ: SendMessage { event_type:'INVITE_ACCEPTED' }
    SM-->>N: 200 OK { sessionToken, profile }
```

### 6.3 Ordinary login (returning store user)

Same shape as the Admin Module's §4.4 — `InitiateAuth(USER_PASSWORD_AUTH)`, success/deactivated/invalid-credentials branches, `SendMessage` to `store-activity-log` — not re-diagrammed. **Billing state has no effect on login** (see `groway-billing-workflow.md`, which replaced an earlier version of that document that did gate login here). A Free-plan Chain, a Paid-plan Chain, and a Chain that just got reverted from Paid to Free all log in exactly the same way — billing only ever affects whether a *new appointment* can be created (`groway-billing-workflow.md` §4), never authentication.

### 6.4 Forgot / reset password (self-service — the customer pattern, not the admin peer-reset pattern)

```mermaid
sequenceDiagram
    actor U as Store user (either app role)
    participant GW as Gateway
    participant SM as Store Module
    participant SCOG as Amazon Cognito
    participant SQSQ as SQS (store-activity-log)

    U->>GW: POST /api/store/auth/password/forgot { email }
    GW->>SM: (in-process)
    SM->>SCOG: ForgotPassword(ClientId, SecretHash, Username=email)
    SCOG-->>SCOG: Send a reset code
    SM->>SQSQ: SendMessage { event_type:'PASSWORD_RESET_REQUESTED' }
    SM-->>U: 200 OK "If that account exists, a code was sent"

    U->>GW: POST /api/store/auth/password/reset { email, code, newPassword }
    GW->>SM: (in-process)
    SM->>SCOG: ConfirmForgotPassword(ClientId, SecretHash, Username=email, ConfirmationCode=code, Password=newPassword)
    alt code valid
        SCOG-->>SM: 200 OK
        SM->>SQSQ: SendMessage { event_type:'PASSWORD_RESET_COMPLETED' }
        SM-->>U: 200 OK "Password updated, please sign in"
    else code invalid/expired
        SCOG-->>SM: CodeMismatchException / ExpiredCodeException
        SM-->>U: 400 Bad Request
    end
```

No Groway admin involved anywhere in this flow — deliberately the easier, self-service path, unlike the internal-admin document's peer-reset model.

### 6.5 Switching stores (multi-store accounts)

```mermaid
sequenceDiagram
    actor U as store_admin or staff (already logged in)
    participant GW as Gateway
    participant SM as Store Module
    participant REDIS as Redis
    participant DB as PostgreSQL (store schema)
    participant SQSQ as SQS (store-activity-log)

    U->>GW: POST /api/store/session/switch-store { storeId }
    GW->>SM: (in-process)
    SM->>REDIS: GET session:<hash(sessionToken)>
    SM->>DB: SELECT 1 FROM store.store_user_store_access WHERE store_user_id=... AND store_id=<storeId>
    alt access granted
        SM->>REDIS: SET session:<hash(sessionToken)> (activeStoreId = storeId, ...)
        SM->>SQSQ: SendMessage { event_type:'STORE_SWITCHED', event_detail:{storeId} }
        SM-->>U: 200 OK { activeStoreId: storeId }
    else not authorized
        SM-->>U: 403 Forbidden
    end
```

Session-context change only — no Cognito call, no new login. A regular `store_admin` holds exactly one access row, so switching is a no-op for them; the Chain owner and multi-store `staff` are the ones who actually switch.

---

## 7. Test data

```sql
INSERT INTO store.store_users (id, cognito_sub, email, display_name, app_role, created_by_admin_id, status, created_at, last_login_at)
VALUES
    ('c1111111-1111-1111-1111-111111111111',
     'd1e2f3a4-0000-0000-0000-000000000001',
     'owner@selahheadspa.com', 'Selah Head Spa Owner', 'store_admin',
     'a2222222-2222-2222-2222-222222222222',  -- Maria Ops, admin.admins
     'active', '2026-09-20 10:00:00-04', '2026-09-25 08:30:00-04'),

    ('c2222222-2222-2222-2222-222222222222',
     'd1e2f3a4-0000-0000-0000-000000000002',
     'anna@selahheadspa.com', 'Anna', 'staff',
     'a2222222-2222-2222-2222-222222222222',
     'active', '2026-09-20 10:05:00-04', '2026-09-24 09:00:00-04');

-- Owner is the Chain owner (billing_accounts.store_admin_id): store_admin of branch 1,
-- plus a cross-store view row for branch 2 (the one exception to one-admin-per-store).
-- Branch 2's own operational admin is created via the same flow (not shown).
-- Anna (staff) picks up shifts at both branches, with a different staff_id per branch
-- (different roster rows per branch).
INSERT INTO store.store_user_store_access (store_user_id, store_id, staff_id, is_primary, granted_by_admin_id)
VALUES
    ('c1111111-1111-1111-1111-111111111111', '99999999-0000-0000-0000-000000000001', NULL, TRUE,  'a2222222-2222-2222-2222-222222222222'),
    ('c1111111-1111-1111-1111-111111111111', '99999999-0000-0000-0000-000000000002', NULL, FALSE, 'a2222222-2222-2222-2222-222222222222'),
    ('c2222222-2222-2222-2222-222222222222', '99999999-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001', TRUE,  'a2222222-2222-2222-2222-222222222222'),
    ('c2222222-2222-2222-2222-222222222222', '99999999-0000-0000-0000-000000000002', 'b1000000-0000-0000-0000-000000000002', FALSE, 'a2222222-2222-2222-2222-222222222222');

-- One operational admin per store, DB-enforced (2026-09-28 decision).
UPDATE store.stores SET store_admin_id = 'c1111111-1111-1111-1111-111111111111'
WHERE id = '99999999-0000-0000-0000-000000000001';
-- Branch 2's store_admin_id points at its own operational admin (created via the same flow, not shown).

INSERT INTO store.store_user_activity_log (store_user_id, event_type, event_detail, ip_address, created_at)
VALUES
    ('c1111111-1111-1111-1111-111111111111', 'ACCOUNT_CREATED', NULL, '203.0.113.10', '2026-09-20 10:00:00-04'),
    ('c1111111-1111-1111-1111-111111111111', 'INVITE_ACCEPTED', NULL, '198.51.100.30', '2026-09-20 10:12:00-04'),
    ('c1111111-1111-1111-1111-111111111111', 'STORE_SWITCHED', '{"storeId":"99999999-0000-0000-0000-000000000002"}', '198.51.100.30', '2026-09-25 08:31:00-04'),
    ('c2222222-2222-2222-2222-222222222222', 'ACCOUNT_CREATED', NULL, '203.0.113.10', '2026-09-20 10:05:00-04'),
    ('c2222222-2222-2222-2222-222222222222', 'LOGIN_SUCCESS', NULL, '198.51.100.31', '2026-09-24 09:00:00-04');
```

*Both the owner and Anna have two `store_user_store_access` rows, one per branch. The owner's rows have no `staff_id`: the branch-1 row is her operational-admin access, the branch-2 row is her Chain-owner cross-store view (the one exception to one-admin-per-store). Anna's rows each carry a different `staff_id`, since her assignable services/schedule can differ by branch. Separately, `store.stores.store_admin_id` pins exactly one operational admin per store.*

---

## 8. Open questions

1. **One `app_role` per account, not per store** — a person who is `store_admin` at one store and `staff` at another needs two separate `store_users` rows/logins. Not solved; a real limitation of this first version.
2. **Session lifetime, MFA, device-management UX** — same open, unresolved status as the other two modules.
