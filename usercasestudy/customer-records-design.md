# Customer Records — Design

**Status:** customer record-keeping — creation, dedup, search, and claiming a guest booking. Closes out two deferred items: `staff-manual-booking-calendar-design.md` §10 (customer search endpoint) and `customer-my-bookings-design.md` §9 (guest-to-account linking).

Baseline: `customer.customers` is owned by the Customer Module; `store.appointments.customer_id` is an application-level reference (no cross-schema FK), nullable — guest bookings keep `guest_*` snapshot columns (`create-appointment-transaction-design.md` §13, §16). Public booking never requires a record (friction is the top priority there); staff manual-entry needs "search and use directly." Authorization is `storeId ∈ caller.AuthorizedStoreIds`; write endpoints live on the Customer Module, read views are exposed through the Store Module (§3).

## 1. Decisions

1. **Dedup key = phone number (E.164-normalized), globally unique.** Phone is the one contact field required everywhere in the booking flow; email is optional and unreliable as a key.
2. **Front-desk record creation is an upsert, not a strict create.** A `409` on an existing customer just creates friction and duplicate records; the response's `created: true/false` tells the UI which happened.
3. **Search scope is the current chain** (people with a booking history in this chain), not the whole platform. A chain is the tenant boundary; cross-chain customer sharing is a v2 product decision, not a v1 default.
4. **Claiming a guest booking is manual in v1** (staff taps "link to this customer"), never automatic. A wrong auto-link (crediting A's booking to B) costs more than the friction of a manual tap; a single-store pilot can absorb that friction.
5. **The transaction document's guest/`customer_id` dual-track is kept as-is.** `guest_*` honestly records what the customer typed at booking time (an audit source); `customer_id` is a later association. The two coexisting is not a conflict.

## 2. Data model

`customer.customers` (owned by the Customer Module; only the v1-needed columns are listed here):

```sql
CREATE TABLE customer.customers (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone      TEXT NOT NULL UNIQUE,              -- E.164, e.g. +14161234567; the dedup key
  name       TEXT NOT NULL,
  email      TEXT,
  language   VARCHAR(5) NOT NULL DEFAULT 'en',  -- en/zh, consumed by the reminders document
  notes      TEXT,                              -- operational preferences only — §6 item 2, no health/medical data
  deleted_at TIMESTAMPTZ,                        -- soft delete (§5.4)
  -- V1 groundwork for V3's AI recall (2026-10-02 ruling, §7) - OR semantics,
  -- never set back to false by anything in the booking flow.
  sms_marketing_consent   BOOLEAN NOT NULL DEFAULT FALSE,
  email_marketing_consent BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_customers_name_prefix ON customer.customers (name text_pattern_ops);
```

- Normalization: strip spaces/dashes/parentheses; a bare 10-digit number becomes `+1…`; a number already carrying `+` is stored as-is. A normalization failure is `400 INVALID_PHONE`.
- v1 deliberately has **no** birthday/membership/stored-value columns — those are a v2 loyalty/marketing concern.

## 3. Where records come from

| Source | Action |
|---|---|
| Staff manual booking, search comes up empty | Create inline (upsert); `customer_id` is written back to the appointment |
| Staff clicks "New" on the customer page | Same as above |
| Public guest checkout | **No record created** (keeps it frictionless); `guest_*` is retained |
| Staff claim | `POST .../claim` links a guest booking to a record (§4.4) |

## 4. Endpoints

### 4.1 Search

`GET /api/store/customers/search?store_id=&q=` — `StoreSession`, scoped to the current chain.

- `q` matches: normalized exact phone, or `name ILIKE 'q%'` (prefix only).
- Returns only customers **with a booking history in this chain** (`EXISTS (appointments WHERE customer_id AND store IN chain)`) — front-desk search results are always "people who've actually been here," reducing mis-selection.
- Returns `id, name, phone (not masked — front desk needs to call, §5), email, language`, capped at 20 rows.

### 4.2 Create (upsert)

`POST /api/store/customers` — `StoreSession` (in-process call into the Customer Module's write path).

```json
// request
{ "store_id": "uuid", "name": "string", "phone": "string", "email": null, "language": "zh", "notes": null }
// response 200
{ "id": "uuid", "created": true }   // created: false if the phone already existed, with the existing id
```

- Phone is normalized, then `ON CONFLICT (phone) DO NOTHING`, re-reading the existing row — the submitted name **does not** overwrite an existing one (a front-desk typo overwriting a real name is a common accident; renaming goes through `PATCH`).
- Rate-limited (IP + store) against database-scraping.

### 4.3 Update

`PATCH /api/store/customers/{id}` — edits `name`/`email`/`language`/`notes`. **`phone` itself cannot be changed** (changing the number means a different person — that's a new record, not an edit; this prevents accidentally repointing A's record to B's number).

### 4.4 Claim a guest booking

`POST /api/store/customers/{id}/claim` `{ "appointment_id": "uuid" }` — `StoreSession`.

- Validates: the appointment belongs to this store, and `customer_id IS NULL` (already-linked → `409 ALREADY_LINKED`).
- Success: `appointments.customer_id = id` (`guest_*` is left untouched — it stays the audit source).
- Emits `appointment.customer_linked` (reserved for future consumers; none in v1).

## 5. Permission matrix

| Action | Staff (own store) | `store_admin` | `chain_admin` |
|---|---|---|---|
| Search chain customers | ✅ | ✅ | ✅ |
| Create / update | ✅ | ✅ | ✅ |
| Claim a booking | Own store's bookings only | Own store | Within chain |
| View full phone number | ✅ (operational need) | ✅ | ✅ |

- Cross-chain search returns nothing (decision 3); cross-store-within-chain is visible (the chain is the tenant).

## 6. Privacy notes

1. Front desk seeing a full phone number is an operational need (calling/texting), but the customer *list* page masks it by default (`416-***-4567`) and expands only on the detail view — guards against passive screen-glancing.
2. **`notes` is operational preferences only — "prefers a quiet room," "speaks Mandarin" — never health or medical information, and never evaluative commentary.** (2026-10-02 constraint, tightened from an earlier draft that used "allergies" as its own example — allergies *are* health data, and this plaintext, front-desk-visible field has none of the isolation/encryption/audit treatment that kind of data needs.) Once something like "allergic to lidocaine" lands here in plaintext, the exposure already happened — there's no un-ringing that bell after the fact, which is why this is a write-time constraint, not a cleanup task. Health/medical information waits for a dedicated, isolated table (flagged for the med-aesthetics legal review, out of scope here) — it does not belong in this column even temporarily. The UI placeholder text makes the operational-only scope explicit, not just this document.
3. Bulk customer-list export is **not built in v1** — every export is a new leakage surface; if needed later, it goes through an approval flow (v2).
4. Deletion: a customer-requested deletion is a soft delete (`deleted_at`); appointment history is retained (financial/audit need), displayed with the name masked as "Deleted customer."

## 7. Marketing consent carry-over (V1 groundwork for V3's AI recall, 2026-10-02)

The CASL basis for a future AI win-back SMS is captured per-booking (`create-appointment-transaction-design.md` §1 decision 13: `sms_marketing_consent`/`email_marketing_consent` on `appointments`, both default `false`). This section is how that lands on the durable customer record — the thing V3's AI recall actually queries.

- **OR semantics, not "latest wins."** Any booking with `true` sets the matching column `true` on the customer record; nothing in the booking flow ever sets it back to `false`. A consent checkbox defaults to unchecked on every booking form — if an unchecked box on a *later*, unrelated booking could silently flip a previously-given `true` back to `false`, a real opt-in would be destroyed by a customer simply not noticing a box that resets every time. CASL consent is treated as an asset here, not a snapshot of "what did they say most recently."
- **Trigger: any booking↔customer association**, not only the manual claim (§4.4) — also at ordinary creation time whenever `customer_id` is already resolved (a logged-in customer, or a staff-entered booking for an existing customer, `create-appointment-transaction-design.md` §13). Both paths run the identical update; with OR semantics there's no ordering to get right between them.
- **Mechanism**: the Customer Module consumes `store.outbox`'s `appointment.created` event (already carries `customer_id` when resolved) and `appointment.customer_linked` (claim, §4.4) — `UPDATE customer.customers SET sms_marketing_consent = sms_marketing_consent OR :new_value, email_marketing_consent = email_marketing_consent OR :new_value WHERE id = :customer_id`. No direct cross-schema write from the Store Module's creation transaction — consistent with `customer_id` already being an application-level reference, never an enforced FK.
- **Revocation is explicitly out of v1 scope** — an unsubscribe link or a staff-recorded "customer asked to stop" is a real future action on this same column, just not designed here. v1 only ever moves this `true`.

## 8. Test cases

1. Creating with the same phone number twice → the second call returns `created: false`, same id, no duplicate row.
2. `416-123-4567` and `+14161234567` both create → resolve to the same record.
3. Chain A searching for Chain B's customer → zero results.
4. Claiming an already-linked booking → `409 ALREADY_LINKED`.
5. After a claim, `guest_name` is still present and `customer_id` is now set.
6. Attempting to change `phone` → `400`.
7. Searching `q=` a name prefix matches; a mid-name substring does not.
8. Guest books with `sms_marketing_consent=true`, is later claimed onto a customer record → that record's `sms_marketing_consent` becomes `true`.
9. A customer with `sms_marketing_consent=true` already on record books again with the checkbox left unchecked → the customer record's value stays `true` (unchanged), even though this new booking's own row has `false`.
10. A staff-entered booking for an existing customer, with the consent box checked → the same `UPDATE ... OR` path fires at creation time, no claim action needed.

## 9. Deferred

1. Automatic guest-to-record linking by phone match — v2, pending data on manual-claim error rates.
2. Duplicate-record merging — rare once phone-based dedup is in place.
3. Customer self-service profile editing (requires an account system).
4. Birthday/membership/stored-value/loyalty-point fields (loyalty v2).
5. Approval flow for customer-list export.
6. Marketing-consent revocation (unsubscribe link, staff-recorded opt-out) — §7's columns exist, but v1 has no path that ever sets them back to `false`.
7. A dedicated, isolated table for health/medical information (med-aesthetics legal review) — `notes` (§2/§6) is explicitly not that table.
