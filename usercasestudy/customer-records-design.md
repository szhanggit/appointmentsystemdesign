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
  notes      TEXT,                              -- allergies, preferences, etc. — visible to front desk
  deleted_at TIMESTAMPTZ,                        -- soft delete (§5.4)
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
2. `notes` is service-relevant only (allergies, preferences) — **never** evaluative commentary. The UI placeholder text makes this explicit.
3. Bulk customer-list export is **not built in v1** — every export is a new leakage surface; if needed later, it goes through an approval flow (v2).
4. Deletion: a customer-requested deletion is a soft delete (`deleted_at`); appointment history is retained (financial/audit need), displayed with the name masked as "Deleted customer."

## 7. Test cases

1. Creating with the same phone number twice → the second call returns `created: false`, same id, no duplicate row.
2. `416-123-4567` and `+14161234567` both create → resolve to the same record.
3. Chain A searching for Chain B's customer → zero results.
4. Claiming an already-linked booking → `409 ALREADY_LINKED`.
5. After a claim, `guest_name` is still present and `customer_id` is now set.
6. Attempting to change `phone` → `400`.
7. Searching `q=` a name prefix matches; a mid-name substring does not.

## 8. Deferred

1. Automatic guest-to-record linking by phone match — v2, pending data on manual-claim error rates.
2. Duplicate-record merging — rare once phone-based dedup is in place.
3. Customer self-service profile editing (requires an account system).
4. Birthday/membership/stored-value/loyalty-point fields (loyalty v2).
5. Approval flow for customer-list export.
