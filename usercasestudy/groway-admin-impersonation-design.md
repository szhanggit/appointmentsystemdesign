# Groway Admin "Login As" — Design

**Status:** lets a Groway admin act on a chain's behalf for support purposes. Builds on `store-onboarding-v1-design.md` §6 (the existing rule that a Groway admin never calls `/api/store/*` directly) and `growayshop-registration-workflow.md` §3 (the in-process `/api/admin/*` dispatch pattern already used for chain creation). This document doesn't reopen either of those — it's the same pattern applied to a new, scoped set of support actions.

## 1. Decisions

1. **"Login as" mints no session.** It's a UI framing over the existing `/api/admin/*` in-process dispatch pattern — the admin console calls an `/api/admin/*` endpoint, which invokes the same underlying Store Module service methods the owner's own UI calls, carrying an `actedBy: { adminId, onBehalfOf: chainId }` audit context through. From the admin's screen it looks like being logged in as the chain; architecturally there is no cross-`population` session, and `store-onboarding-v1-design.md` §6's module boundary (why a Groway admin's `AdminSession` is rejected outright on any `/api/store/*` route) is untouched.
2. **Scoped allow-list, not full parity.** "Admin can do what the owner can do" read literally would mean every `/api/store/*` capability needs a permanently-maintained `/api/admin/*` mirror. v1 builds exactly four: view what the owner sees, cancel/reschedule a booking on a customer's behalf, view billing, and unstick one stuck appointment. New mirrors get added by the same existing pattern as new support needs arise — `store-onboarding-v1-design.md` §6 already states this principle ("rather than pre-building a parallel admin-side CRUD surface now"); this document doesn't change it.
3. **No prior consent required; notification is mandatory and automatic.** The chain is told after the fact, every time, with no way to suppress it.
4. **Sensitive actions require a ticket number — forward-looking, not yet wired to anything.** Suspending a store and issuing a refund are the two named sensitive actions, and neither is in v1's four-item allow-list (chain billing has no payment gateway, so there's nothing to refund in the first place). The ticket-required rule is written now so it applies automatically the day either action gets built, rather than being retrofitted.

## 2. Allow-list (v1)

| Action | What it does |
|---|---|
| View owner's view | Read-only mirror of what `chain_admin`/`store_admin` would see (calendar, catalog, etc.) |
| Cancel / reschedule on a customer's behalf | Calls the same underlying appointment service methods as `create-appointment-transaction-design.md` §3.3, with `actedBy` set |
| View billing | Read-only mirror of `groway-billing-workflow.md` §8's status endpoint |
| Unstick one appointment | A manual fix for a single appointment stuck in an inconsistent state (e.g. a webhook that never arrived) |

Nothing else is buildable via impersonation in v1. In particular, **suspending a store and issuing a refund are not in this list** — see decision 4.

## 3. Audit logging

Every impersonated action writes:

```sql
CREATE TABLE admin.impersonation_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_id        UUID NOT NULL,                    -- cross-schema reference to admin.admins.id
    acting_as_type  VARCHAR(10) NOT NULL CHECK (acting_as_type IN ('chain', 'store')),
    acting_as_id    UUID NOT NULL,                     -- chain_id or store_id depending on acting_as_type
    action          VARCHAR(50) NOT NULL,
    ticket_ref      VARCHAR(50),                        -- required for sensitive actions (decision 4); NULL otherwise
    emergency_entry BOOLEAN NOT NULL DEFAULT false,      -- true when a sensitive action proceeded without a ticket (§4)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_impersonation_log_admin_id ON admin.impersonation_log(admin_id);
CREATE INDEX idx_impersonation_log_acting_as ON admin.impersonation_log(acting_as_type, acting_as_id);
```

Every call through the allow-list writes one row here, regardless of ticket status.

## 4. Sensitive actions and ticket enforcement

A sensitive action (suspend a store, issue a refund — not yet built, decision 4) requires `ticket_ref` to be non-null. An emergency entry without a ticket is allowed but sets `emergency_entry=true`, which:
- Triggers an immediate alert (same alerting channel as any other on-call page — not designed further here).
- Queues the action for after-the-fact review.

This enforcement lives in the shared dispatch path all four (eventually more) allow-listed actions go through, not duplicated per-action.

## 5. Post-action notification

Sent via the message board (`groway-store-notifications-workflow.md` §4a, `store.messages`, `system_subtype='admin_impersonation'`), **never** a bespoke direct-send email. Going through the existing mechanism means it automatically inherits:
- The chain-scoped, `chain_admin`-only recipient resolution already built there (§2 of that document).
- No separate "who do we email" logic to get wrong — the recipient is always `chain_admin`, never "the store owner," because a store can have no `store_admin` at all (`store_admin_id` may be `NULL`, see `growayshop-registration-workflow.md` §6.2 as revised).

Copy: "Groway support accessed your account at {time} regarding ticket #{ticket_ref}." (Pilot period: this may be communicated verbally first; formalize into the terms of service before general availability.)

## 6. Test cases

1. An admin views a chain's calendar via "Login as" → no `store` population session is ever created; the request is traceable as an `/api/admin/*` call with `actedBy` set.
2. Cancelling a booking on a customer's behalf writes one `impersonation_log` row and triggers the same cancellation side effects (outbox event, notification) as if the customer had cancelled directly.
3. An emergency entry without a ticket (once suspend/refund exist) sets `emergency_entry=true` and fires an alert immediately.
4. Every allow-listed action, regardless of ticket status, results in exactly one message-board notification to the chain's `chain_admin`.
5. A store with `store_admin_id = NULL` still receives the post-action notification (addressed to `chain_admin`, never blocked by a missing store-level contact).

## 7. Deferred

1. Suspend a store, issue a refund — both named in decision 4's forward-looking ticket rule, neither built in v1 (chain billing has no payment gateway to refund from).
2. A Groway-admin compose/review UI for the impersonation log — the table and the four allow-listed actions exist; a dedicated review dashboard is a later admin-console feature.
3. Full parity with every owner-facing capability — explicitly rejected (decision 2), not a v1.1 backlog item so much as a standing principle.
