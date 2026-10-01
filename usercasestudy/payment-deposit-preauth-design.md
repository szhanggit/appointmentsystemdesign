# Payment: Deposit / Pre-auth — Design

**Status:** online deposit collection for stores with `booking_settings.payment_required=true`. Closes two deferred hooks: `create-appointment-transaction-design.md` §14 (`payment_required` only creates a `pending` row) and `public-booking-end-to-end-design.md` §8 (deposits).

Baseline: provider is **Stripe** (2.9% + CA$0.30 per domestic card transaction in Canada, no monthly fee; native pre-auth/Apple Pay/Google Pay support). Card data never touches Groway's servers (Stripe.js / Payment Element → PCI SAQ A). Stripe is the source of truth for money; Groway stores a mirror plus an audit ledger. **Deposits land in the chain's own Stripe account** (one account per chain, §3) — never Groway's, and not the business partner's. Stripe's processing fee is deducted automatically from that chain's own payout, the same as for any other Stripe merchant; there is nothing for a third party to "bear" in this flow. This is a different cost arrangement than `customer-booking-confirmation-reminders-design.md` §8's SMS cost, which the partner does cover platform-wide — deposits never route through the partner at all, and "partner" in that other document should not be read as applying here.

## 1. Decisions

1. **v1 captures the deposit directly at booking time — no pre-auth hold.** A pre-auth hold expires after 7 days, which silently fails for a booking made well in advance; a direct capture has no such expiry, and the no-show policy is simply "the deposit isn't refunded" — one fewer capture step. Pre-auth hold is deferred to v2 (§11).
2. **Deposit amount is store-configured, fixed or percent** (one or the other). A spa's real-world policy is either "$30 deposit" or "50% deposit."
3. **Cancellation policy: cancelling inside the free window auto-refunds; a late cancel or no-show keeps the deposit** (`late_cancel_refund`, default `false`). The point of a deposit is no-show protection, which only works if the default is "no refund"; the checkout page must say so explicitly.
4. **A provider abstraction (`IPaymentProvider`) is built in v1**, with Stripe as its first implementation — so adding a country-specific method later doesn't touch booking code.
5. **Refunds go through a store-side button in v1** (`store_admin`+), not the Stripe dashboard directly — keeping every refund inside Groway's audit ledger; a refund that bypasses it is a blind spot.

## 2. Scope

v1 builds:
- Deposit capture on public checkout (card / Apple Pay / Google Pay, via Stripe).
- Auto-refund and no-refund rules on cancel/reschedule.
- An in-store refund button plus an audit ledger.
- Webhook reconciliation.

v1 does not build: full prepayment, in-store card terminal (Stripe Terminal), split payouts (Stripe Connect), pre-auth hold (§11), subscriptions/membership cards.

## 3. Provider model

```sql
-- Owned by the store schema (money follows the chain)
CREATE TABLE store.payment_provider_accounts (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id             UUID NOT NULL,              -- one Stripe account per chain
  provider_code        TEXT NOT NULL,              -- 'stripe' (room for 'alipay' etc. later)
  country              CHAR(2) NOT NULL,           -- 'CA'
  external_account_id  TEXT NOT NULL,               -- Stripe account id (acct_...)
  credentials_ref      TEXT NOT NULL,               -- Vault reference, never a plaintext key
  status               TEXT NOT NULL DEFAULT 'pending',  -- pending/active/suspended
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (chain_id, provider_code)
);
```

- Account setup is a manual step done by the chain itself (Stripe KYC, their own business entity) — not by Groway or by Groway's business partner; once done, the chain hands over the account id, which gets entered here, and the key goes into Vault.
- Code side: `IPaymentProvider` interface (`create_payment`, `refund`, `get_status`); `StripeProvider : IPaymentProvider`.
- Adding a country-specific method later is a new implementation class plus a new `provider_code` — the booking flow doesn't change.

## 4. Payment method selection (three layers)

1. **Provider × country defines capability**: Stripe in CA offers card/Apple Pay/Google Pay; a new country's capability list comes from the provider.
2. **Store opts in**: `booking_settings.payment_methods_enabled[]` (e.g. `['card','apple_pay','google_pay']`), defaulting to the provider's recommended set for that country; `chain_admin` can turn individual methods off.
3. **Customer picks at checkout**: the Payment Element renders the store's enabled methods as tabs.
4. Not purely country-automatic (a customer may distrust a given method) and not unrestricted customer choice (the store needs to retain control).

## 5. Deposit configuration (`booking_settings` additions)

| Field | Meaning |
|---|---|
| `payment_required` | Already exists; `true` activates this document |
| `deposit_type` | `'fixed'` \| `'percent'` |
| `deposit_fixed_cents` | Used when `fixed`, e.g. `3000` = CA$30 |
| `deposit_percent` | Used when `percent`, e.g. `50`; computed off the snapshotted item total, rounded to the cent |
| `late_cancel_refund` | Whether a late cancel refunds the deposit, default `false` |
| `payment_methods_enabled` | §4's opt-in list |

- Deposit is always ≤ order total; a `free`-priced order with `payment_required` skips Stripe entirely (nothing to charge).
- Checkout copy must state: "Deposit CA$X. Cancelling more than Y hours before start is refunded automatically; within Y hours or a no-show forfeits it." (`Y` = `cancel_threshold_hours`.)

## 6. Checkout flow

For a `payment_required=true` store's public booking:

```
1. POST /api/store/public/appointments (create-appointment-transaction-design.md §3.1)
   → creates pending, payment_status='awaiting', occupies the slot (standard TTL)
   → server creates a Stripe PaymentIntent (amount = deposit, idempotency key = appointment.id)
   → returns { appointment_id, client_secret, deposit_cents }
2. Client Payment Element collects payment → stripe.confirmCardPayment(client_secret)
   → customer picks their method at this layer (§4)
3. Webhook payment_intent.succeeded → payment_status='succeeded'
   → auto_confirm=true: becomes confirmed; otherwise stays pending (awaiting staff confirmation)
   → confirmation SMS sent (per the reminders document's normal flow)
4. Webhook payment_intent.payment_failed, or 15 minutes unpaid
   → cancel the PaymentIntent → appointment expires → slot released (same TTL mechanism as any other pending)
```

- **A successful client-side callback is not success** — the webhook is authoritative; the client only handles UX navigation.
- Amount is always computed server-side from the item snapshot — **the client-submitted amount is never trusted**.
- Reschedule doesn't re-collect payment (the deposit stays with the booking); if the total changes on reschedule, the deposit amount doesn't follow — a simple v1 rule.

## 7. Cancel / no-show / refund

| Scenario | Action |
|---|---|
| Cancel outside the free window | Auto-refund (worker listens for `appointment.cancelled`) |
| Cancel inside the window | Refunded only if `late_cancel_refund=true` |
| No-show | Deposit kept (policy already stated at checkout) |
| Completed | No action (deposit-vs-final-bill reconciliation is in-store POS, out of scope for v1) |
| Manual in-store refund | `POST /api/store/appointments/{id}/refund` (`store_admin`+), calls `provider.refund`, full amount only (v1 doesn't support partial) |

- Every money movement writes to `store.payment_events` (append-only): `appointment_id, provider_code, external_intent_id, type (capture/refund), amount_cents, status, webhook_id, created_at`.
- `appointments` gains: `payment_status` (`none|awaiting|succeeded|failed|refunded|partially_refunded`), `payment_intent_id`, `deposit_amount_cents`.

## 8. Webhooks

- `POST /api/webhooks/stripe` (public, verifies the `Stripe-Signature` header; a failed verification is an immediate `400`).
- Deduplicated by `event.id` (`payment_events.webhook_id` unique constraint absorbs replays).
- Only a whitelisted set is processed: `payment_intent.succeeded`, `payment_intent.payment_failed`, `charge.refunded`. Anything else is logged, not acted on.
- Webhook processing and the appointment state transition happen in **the same DB transaction** — avoids "charged but never confirmed."

## 9. Security

1. The secret key lives only in server-side Vault; the client only ever sees the publishable key.
2. Amount is always server-computed; the PaymentIntent amount is double-checked against the appointment's stored deposit — a mismatch is rejected.
3. Webhook signature is verified; a client-side redirect is never treated as proof of success.
4. The refund endpoint is `store_admin`+ only, and can only refund that store's own appointments.
5. No card number or CVV is ever stored (Groway never receives them in the first place).

## 10. Test cases (Stripe test mode, free)

1. Book → test card `4242…` → webhook → `succeeded` → confirmed + SMS sent.
2. Test card `4000…0002` (decline) → `payment_failed` → appointment expires after 15 minutes, slot released.
3. The same webhook event delivered twice → one ledger row, one state transition.
4. Client submits a tampered `deposit_cents=1` → server recomputes from the snapshot, rejects on mismatch with `400`.
5. Cancel outside the free window → auto-refund, a `refund` row appears in `payment_events`.
6. No-show → deposit retained, no refund row.
7. An unverified webhook signature → `400`, no state change.

## 11. Deferred (v2)

1. **Pre-auth hold**: hold at booking, capture on completion. v1 uses direct capture specifically to avoid the 7-day expiry problem.
2. Full prepayment (not just a deposit).
3. Stripe Terminal (in-store card reader).
4. Stripe Connect (multi-chain split payouts / platform fee).
5. New-country providers (e.g. direct Alipay/WeChat Pay integration).
6. Partial refunds; converting a deposit into store credit.
