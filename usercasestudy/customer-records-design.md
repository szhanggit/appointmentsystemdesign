# Customer Records — Design

**Status:** customer record-keeping — creation, dedup, search, and claiming a guest booking. Closes out two deferred items: `staff-manual-booking-calendar-design.md` §10 (customer search endpoint) and `customer-my-bookings-design.md` §9 (guest-to-account linking).

Baseline: `customer.customers` is owned by the Customer Module; `store.appointments.customer_id` is an application-level reference (no cross-schema FK), nullable — guest bookings keep `guest_*` snapshot columns (`create-appointment-transaction-design.md` §13, §16). Public booking never requires a record (friction is the top priority there); staff manual-entry needs "search and use directly." Authorization is `storeId ∈ caller.AuthorizedStoreIds`; write endpoints live on the Customer Module, read views are exposed through the Store Module (§3).

## 1. Decisions

1. **Dedup key = phone number (E.164-normalized), globally unique.** Phone is the one contact field required everywhere in the booking flow; email is optional and unreliable as a key.
2. **Front-desk record creation is an upsert, not a strict create.** A `409` on an existing customer just creates friction and duplicate records; the response's `created: true/false` tells the UI which happened.
3. ~~Search scope is the current chain (people with a booking history in this chain), not the whole platform. A chain is the tenant boundary; cross-chain customer sharing is a v2 product decision, not a v1 default.~~ — **reversed 2026-10-03 (Steven, #8), the Fresha marketplace model.** `customer.customers` was already a single, platform-level table, globally unique by phone — what changes is *visibility*, not storage. **Any chain with ≥1 appointment row for a `customer_id` (any status, any store in that chain) may view that customer's operational profile** (name, phone, email, notes) — one profile, visible to every merchant the customer has booked with. See §4.1/§5 for the full rule and its guardrails — this is profile visibility only, never cross-chain booking history (Chain B never sees "this customer also booked at Chain A").
4. **Claiming a guest booking is manual in v1** (staff taps "link to this customer"), never automatic. A wrong auto-link (crediting A's booking to B) costs more than the friction of a manual tap; a single-store pilot can absorb that friction. **Unclaiming is the exact mirror** (NEW, 2026-10-03, #9) — see §4.5.
5. **The transaction document's guest/`customer_id` dual-track is kept as-is.** `guest_*` honestly records what the customer typed at booking time (an audit source); `customer_id` is a later association. The two coexisting is not a conflict.

## 2. Data model

`customer.customers` (owned by the Customer Module; only the v1-needed columns are listed here):

```sql
CREATE TABLE customer.customers (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone      TEXT NOT NULL UNIQUE,              -- E.164, e.g. +14161234567; the dedup key
  name       TEXT NOT NULL,
  email      TEXT,
  -- language DROPPED 2026-10-03 (#22, V1 is English-only — no i18n framework,
  -- no translated content, no other UI languages). customer-booking-confirmation-reminders-design.md
  -- sends English-only templates in V1; there is nothing left for this column to drive.
  notes      TEXT,                              -- operational preferences only — §6 item 2, no health/medical data
  deleted_at TIMESTAMPTZ,                        -- soft delete (§5.4)
  -- "Ever consented, anywhere" groundwork for V3's AI recall (2026-10-02 ruling, §7) -
  -- OR semantics, never set back to false by anything in the booking flow. 2026-10-03
  -- (#8): these stay as this global, cross-chain signal; actually SENDING marketing
  -- requires the per-chain record in customer_chain_consents (below) instead - a
  -- chain cannot mail a customer on consent another chain collected (CASL).
  sms_marketing_consent   BOOLEAN NOT NULL DEFAULT FALSE,
  email_marketing_consent BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_customers_name_prefix ON customer.customers (name text_pattern_ops);

-- Per-chain marketing consent (NEW, 2026-10-03, #8). Chain B may not send
-- marketing on consent given to Chain A (CASL) even though both chains can
-- now both VIEW the same profile (decision 3) - visibility and the right to
-- market are two different permissions, and this table is what gates the
-- second one. One row per (chain, customer) that has ever had a consent
-- event; absence of a row means "never asked / no signal" at that chain.
CREATE TABLE customer.customer_chain_consents (
  chain_id      UUID NOT NULL,  -- application-level reference to store.chains.id, no cross-schema FK (architecture doc §5)
  customer_id   UUID NOT NULL REFERENCES customer.customers(id),
  sms_consent   BOOLEAN NOT NULL DEFAULT FALSE,
  email_consent BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, customer_id)
);
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

### 4.1 Search — phone-exact goes global, name-fuzzy stays chain-scoped (2026-10-03, #8)

`GET /api/store/customers/search?store_id=&q=` — `StoreSession`.

**The server auto-detects which kind of query this is — no separate parameter, one search box:**
- `q` normalizes to a valid phone-number shape (same `normalize_phone()` as everywhere else in this project) **and** matches a stored `phone` exactly → **global**: returns that customer regardless of which chain(s) they've booked with, as long as *this* caller's chain has ≥1 appointment row for them (decision 3's rule — this chain still has to have met them; global search finds the person, it doesn't grant visibility into someone this chain has never interacted with). Rationale: the phone is already the dedup key, and the searcher already knows the number — there's no new enumeration surface, they're confirming a match on data they already hold.
- Otherwise (not phone-shaped, or no exact phone match) → **chain-scoped `name ILIKE 'q%'` fuzzy match** (prefix only), same as before — anti-enumeration of the platform's customer base; a name-based search was never intended to let one chain browse another chain's customers.
- A name that happens to look like a phone number is an accepted edge case, not specially handled — falls through to chain-scoped fuzzy matching when it doesn't exactly match a stored phone.
- Returns only customers **this chain has met** (`EXISTS (appointments WHERE customer_id AND store IN chain, any status)`, decision 3) — front-desk search results are always "someone with a real booking history with us," reducing mis-selection.
- Returns `id, name, phone (not masked — front desk needs to call, §5), email`, capped at 20 rows.
- **Mechanism (2026-10-02, made explicit; extended 2026-10-03 for the global-phone path): two phases, never a cross-schema `JOIN`.** (1) Store Module resolves `customer_id`s with booking history in *this caller's* chain — a Store-local query, `SELECT DISTINCT customer_id FROM store.appointments WHERE store_id IN (chain's stores) AND customer_id IS NOT NULL`. (2) Store Module calls the Customer Module's Contracts interface with that id set plus `q`, which does the actual phone/name matching entirely within Customer's own schema. The global-phone branch doesn't change this shape — it's the same phase-2 call, just matching across all of `customer.customers` by exact phone instead of restricting the match itself to the phase-1 id set; the phase-1 "has this chain met them" filter is what's applied either way, after the match.

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

- Validates: the appointment belongs to this store, `customer_id IS NULL` (already-linked → `409 ALREADY_LINKED`), **and `{id}`'s customer record has a booking history in this chain** (2026-10-02 fix — note this check is unaffected by #8's decision-3 reversal: claiming is a stronger action than viewing, and stays chain-scoped — a chain can *see* a cross-chain-known profile per decision 3, but can only *claim onto* a record that already has history with this specific chain, same chain-scoping as §4.1's search). Fails → `404`, the same "don't let the status code confirm existence outside your scope" convention used everywhere else in this project, not a `409` — this isn't a real conflict, it's an out-of-scope reference.
- Success: `appointments.customer_id = id` **and `appointments.normalized_contact_phone = ` that customer's normalized phone** (2026-10-02 fix — `create-appointment-transaction-design.md` §6.3 already documented this as this endpoint's responsibility; it just wasn't written here yet. Without it, the phone-cap count keeps tallying the claimed booking against the old guest-typed number instead of the customer record's number, which is exactly the drift the snapshot column was built to avoid). `guest_*` is left untouched — it stays the audit source.
- Emits `appointment.customer_linked` (reserved for future consumers; none in v1).

**Claim UI phone-match suggestion (NEW, 2026-10-03, #9).** When a staff member opens the claim flow for an unclaimed appointment, the UI runs §4.1's exact-phone-global lookup against that appointment's `guest_phone` and, if it finds a match, surfaces "Possible match: {name}" as a one-tap suggestion to speed up linking — the staff member still has to confirm by actually tapping claim, this is a suggestion, not an auto-link (decision 4 stands: claiming stays manual). This reuses the same global phone-exact mechanism #8 introduced for search, not a new lookup.

### 4.5 Unclaim a booking (NEW, 2026-10-03, #9)

`POST /api/store/customers/unclaim` `{ "appointment_id": "uuid" }` — `StoreSession`. Same permissions as claim (§5).

- Sets `appointments.customer_id` back to `NULL`. Clean because claim never overwrites `guest_*` (decision 5) — unclaiming just un-does the association, the original guest-typed snapshot was never touched and is still there to show.
- `normalized_contact_phone` is **left as-is** (not reverted to the original `guest_phone`'s normalization) — it reflects "what phone number was this booking last counted against for the phone cap," which is a historical fact about what actually happened, not something unclaiming should rewrite.
- Audit-logged, same activity-log mechanism as claim.
- Powers the "Unclaimed" badge becoming re-applicable, and the reverse of a mis-claim — a staff member who claimed the wrong appointment onto the wrong customer can undo it without any special recovery procedure.

## 5. Permission matrix

| Action | Staff (own store) | `store_admin` | `chain_admin` |
|---|---|---|---|
| Search chain customers (name-fuzzy) | ✅ | ✅ | ✅ |
| Search by exact phone (global, #8) | ✅, gated on this chain already having met them | ✅ | ✅ |
| Create / update | ✅ | ✅ | ✅ |
| Claim / unclaim a booking | Own store's bookings only | Own store | Within chain |
| View full phone number | ✅ (operational need) | ✅ | ✅ |

- **2026-10-03 (#8): cross-chain name-fuzzy search still returns nothing** (unchanged from decision 3's original anti-enumeration intent) — **but a chain that has ≥1 appointment with a customer can now view that customer's profile**, even if that appointment came through a different flow than search (e.g. an exact-phone match). Cross-store-within-chain is visible (the chain is the tenant) — unchanged.
- **What "view the profile" never includes: another chain's booking history.** A chain_admin viewing a shared profile sees name/phone/email/notes — never "this customer also booked at Chain X 5 times." Bilateral visibility of the profile, zero cross-chain history leakage — this is the one hard line decision 3's reversal does not cross.
- Guest bookings are unaffected by any of this — no profile, nothing to share, nothing changes.

## 6. Privacy notes

1. Front desk seeing a full phone number is an operational need (calling/texting), but the customer *list* page masks it by default (`416-***-4567`) and expands only on the detail view — guards against passive screen-glancing.
2. **`notes` is operational preferences only — "prefers a quiet room," "speaks Mandarin" — never health or medical information, and never evaluative commentary.** (2026-10-02 constraint, tightened from an earlier draft that used "allergies" as its own example — allergies *are* health data, and this plaintext, front-desk-visible field has none of the isolation/encryption/audit treatment that kind of data needs.) Once something like "allergic to lidocaine" lands here in plaintext, the exposure already happened — there's no un-ringing that bell after the fact, which is why this is a write-time constraint, not a cleanup task. Health/medical information waits for a dedicated, isolated table (flagged for the med-aesthetics legal review, out of scope here) — it does not belong in this column even temporarily. The UI placeholder text makes the operational-only scope explicit, not just this document.
3. Bulk customer-list export is **not built in v1** — every export is a new leakage surface; if needed later, it goes through an approval flow (v2).
4. Deletion: a customer-requested deletion is a soft delete (`deleted_at`); appointment history is retained (financial/audit need), displayed with the name masked as "Deleted customer."
5. **Consent copy must disclose cross-chain profile sharing (NEW, 2026-10-03, #8 — PIPEDA).** Now that a profile is visible to every merchant a customer has booked with (decision 3), the booking/account consent text shown at creation time must state this plainly — something to the effect of "your name, phone, and booking notes may be visible to other Groway merchants you book with." The customer's own "where you've booked" list (`customer-my-bookings-design.md`) is the natural, honest "who can see me" disclosure surface — a customer can always see exactly which chains have interacted with them, which is the same set that can see their profile.

## 7. Marketing consent carry-over — now writes BOTH the global and per-chain record (2026-10-03, #8, extends the 2026-10-02 design)

The CASL basis for a future AI win-back SMS is captured per-booking (`create-appointment-transaction-design.md` §1 decision 13: `sms_marketing_consent`/`email_marketing_consent` on `appointments`, both default `false`). This section is how that lands on the durable customer records — both the global "ever consented, anywhere" signal on `customer.customers`, and (new) the per-chain record that actually gates sending.

- **Two writes per consent event, not one.** (1) `customer.customers.sms_marketing_consent`/`email_marketing_consent` — unchanged from the original design, OR semantics, global, "has this person ever said yes to anyone" (V3 AI recall's eventual signal). (2) **`customer.customer_chain_consents` (NEW, 2026-10-03, #8)** — the per-chain row for *this specific chain*, same OR semantics, upserted: `INSERT ... (chain_id, customer_id, sms_consent, email_consent) VALUES (...) ON CONFLICT (chain_id, customer_id) DO UPDATE SET sms_consent = customer_chain_consents.sms_consent OR EXCLUDED.sms_consent, email_consent = customer_chain_consents.email_consent OR EXCLUDED.email_consent, updated_at = now()`. **Only the per-chain row gates whether a chain may actually send marketing** — the global column is signal/groundwork, never itself the send-authorization check. A chain that has never had a booking with `true` consent has no row here at all, and sending to that customer on their behalf is simply not authorized, regardless of what the global column says about some *other* chain's consent history with the same person.
- **OR semantics at both levels, not "latest wins."** Any booking with `true` sets the matching column `true`, at both the global and the per-chain level; nothing in the booking flow ever sets either back to `false`. A consent checkbox defaults to unchecked on every booking form — if an unchecked box on a *later*, unrelated booking could silently flip a previously-given `true` back to `false`, a real opt-in would be destroyed by a customer simply not noticing a box that resets every time. CASL consent is treated as an asset here, not a snapshot of "what did they say most recently."
- **Trigger: any booking↔customer association**, not only the manual claim (§4.4) — also at ordinary creation time whenever `customer_id` is already resolved (a logged-in customer, or a staff-entered booking for an existing customer, `create-appointment-transaction-design.md` §13). The `chain_id` for the per-chain write is the store's chain at the moment of that specific booking — every trigger site already has this in scope (it's the same chain the appointment itself belongs to).
- **Mechanism (2026-10-02, made explicit; extended 2026-10-03 for the per-chain write): the Customer Module never reads `store.outbox` directly.** `store.outbox` is Store's own table, in Store's own schema — the Customer Module reaching into it to poll/consume would be exactly the kind of cross-schema coupling `customer_id` being FK-less was supposed to prevent, just moved from a write-time constraint to a read-time query. Instead: a Store-owned relay worker (the same one already delivering `appointment.created`/`confirmed`/`cancelled`/`rescheduled`/`expired` to the SMS/email pipeline, `customer-booking-confirmation-reminders-design.md`) also forwards the subset of events carrying a resolved `customer_id` **and the originating `chain_id`** — `appointment.created` and `appointment.customer_linked` (claim, §4.4) — onto a Customer-Module-owned queue. The Customer Module consumes *that* queue, never `store.outbox` itself, and runs both OR-upserts above in the same handler. Store owns the relay and the fan-out; Customer owns only its own queue's consumer.
- **Revocation is explicitly out of v1 scope** — an unsubscribe link or a staff-recorded "customer asked to stop" is a real future action on these same columns, just not designed here. v1 only ever moves either `true`.

## 8. Test cases

1. Creating with the same phone number twice → the second call returns `created: false`, same id, no duplicate row.
2. `416-123-4567` and `+14161234567` both create → resolve to the same record.
3. Chain A name-fuzzy-searching for a customer with no history at Chain A → zero results, even if that customer has history elsewhere (unchanged anti-enumeration behavior). Chain A searching that same customer's **exact phone** → also zero results, **unless** Chain A itself has ≥1 appointment with them (decision 3's gate applies to the global-phone path too, #8).
3a. Chain A has exactly one past (even cancelled) appointment with a customer who mostly books at Chain B → Chain A's exact-phone search finds them, and Chain A can view their profile (name/phone/email/notes) — but any list of "other places this customer has booked" is never shown to Chain A.
4. Claiming an already-linked booking → `409 ALREADY_LINKED`.
4a. Unclaiming a claimed booking → `customer_id` back to `NULL`, `guest_*` fields unchanged (they were never touched by claim), `normalized_contact_phone` unchanged (reflects history, not reverted).
5. After a claim, `guest_name` is still present and `customer_id` is now set.
6. Attempting to change `phone` → `400`.
7. Searching `q=` a name prefix matches; a mid-name substring does not.
8. Guest books with `sms_marketing_consent=true`, is later claimed onto a customer record → that record's `sms_marketing_consent` becomes `true`.
9. A customer with `sms_marketing_consent=true` already on record books again with the checkbox left unchecked → the customer record's value stays `true` (unchanged), even though this new booking's own row has `false`.
10. A staff-entered booking for an existing customer, with the consent box checked → the same `UPDATE ... OR` path fires at creation time, no claim action needed.
11. After a claim, `appointments.normalized_contact_phone` matches the customer record's phone, not the originally-typed `guest_phone` — a subsequent phone-cap count correctly tallies this booking against the customer's number.
12. Claiming a booking onto a `customer_id` belonging to a different chain, when THIS chain has no history with that customer → `404` (claim stays chain-scoped, decision 3's reversal doesn't change §4.4), the booking's `customer_id` left `NULL`.
13. Chain A books a customer with `sms_marketing_consent=true` for the first time → both `customer.customers.sms_marketing_consent` and the new `(chain_id=A, customer_id)` row in `customer_chain_consents` become `true`. Chain B later books the same customer (found via exact-phone global search), consent box left unchecked → Chain B gets no row / a `false` row in `customer_chain_consents` for itself, even though the global column already reads `true` from Chain A's consent — Chain B is still not authorized to send marketing.
14. Claim UI opens for an unclaimed guest booking whose `guest_phone` exactly matches an existing customer record → "Possible match: {name}" suggestion shown; staff still has to tap claim to confirm.

## 9. Deferred

1. Automatic guest-to-record linking by phone match — v2, pending data on manual-claim error rates.
2. Duplicate-record merging — rare once phone-based dedup is in place.
3. Customer self-service profile editing (requires an account system).
4. Birthday/membership/stored-value/loyalty-point fields (loyalty v2).
5. Approval flow for customer-list export.
6. Marketing-consent revocation (unsubscribe link, staff-recorded opt-out) — §7's columns exist, both global and per-chain, but v1 has no path that ever sets either back to `false`.
7. A dedicated, isolated table for health/medical information (med-aesthetics legal review) — `notes` (§2/§6) is explicitly not that table.
8. Bulk/automatic claim suggestions beyond the single-appointment UI hint (§4.4) — deliberately per-appointment only; one phone number can serve multiple people (family sharing), so bulk-claiming would misattribute.
