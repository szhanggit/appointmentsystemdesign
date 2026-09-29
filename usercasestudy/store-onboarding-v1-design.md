# Store Onboarding & Booking Domain — V1 Design

**Status:** replaces `merchant-onboarding-v1-design.md` entirely. That document used "merchant" for a single store location; Groway's terminology was unified on 2026-09-28 (`groway-architecture-decisions.md`) — **"chain"** is the top-level business, **"store"** is one location. "Merchant" is retired from this codebase and reserved for a different future use. This document is written fresh under the new terminology, not derived from the retired one.

**Architecture:** see `groway-v1-architecture.md`. Owned by the **Store Module**, `store` schema. `store.appointments.customer_id` is an **application-level reference** to `customer.customers` (Customer Module's schema) — never a cross-schema FK, per architecture doc §5.

**Relationship to other documents:** this is the fixed reference for the booking-domain tables (stores, staff, services, schedules, appointments) and the Back Office / public booking APIs. `growayshop-registration-workflow.md` owns the *account/identity* layer (chains, chain_admin/store_admin/staff logins) and adds its own columns to `store.stores` via `ALTER TABLE` (`chain_id`, `store_admin_id`) rather than redefining this table — same pattern `groway-billing-workflow.md` uses for `billing_account_id`.

**V1 decision, unchanged from the retired document:** no self-service store registration. A chain's owner emails Groway → Groway admin enters everything into the Back Office (`growayshop-registration-workflow.md` §6.1 now does this at chain-creation time, one or more stores at once).

---

## 1. Terminology

| Term | Meaning |
|---|---|
| **Chain** | The business as a whole — one owner, one or more stores, one billing account (`groway-billing-workflow.md`). Modeled as `store.chains` (`growayshop-registration-workflow.md` §5). |
| **Store** | One physical location or one independent practitioner. Independent practitioner = a store with exactly one staff member (themself). This document's `store.stores` table. |
| **Staff** | A person working at a store. Business-role label (`owner`/`manager`/`staff`, or free text like "CEO") is descriptive only — no bearing on app access (`growayshop-registration-workflow.md` §1 draws the real access-control line). |
| **Service** | A bookable offering, e.g. "Head massage + scalp treatment + neck & shoulder." |
| **Staff ↔ Service** | Many-to-many: which services a given staff member can perform. |
| **Slot** | Booking time granularity, default 15 minutes. |

---

## 2. Onboarding flow

```
Chain owner emails Groway (intake template, §3)
↓
Groway admin creates the chain in Back Office (growayshop-registration-workflow.md §6.1) —
one or more stores, one chain_admin, one store_admin per store, all in one pass
↓
Per store: enter basic info → add services → add staff → assign staff↔service → set business hours / booking rules
↓
Generate each store's public booking link → hand off to the chain
```

Store lifecycle (`store.stores.status`): `pending` (created) → `active` (delivered, bookable) → `suspended`.

---

## 3. Intake email template

```
Subject: {Chain name}

1. Chain name (public-facing):
2. Owner contact / phone / email:
3. Number of stores, and per store:
   - Store name / address / timezone (default America/Toronto)
   - Store type: [] solo practitioner (1 person) [] team store (multiple people)
   - Services (name | duration(min) | price | price type (fixed/variable) | category)
   - Staff (name | phone | which of the above services they perform)
   - Business hours (Mon–Sun, open–close, "closed" if none)
   - Booking rules: slot granularity (default 15 min) / advance-booking window in days (default 90) / auto-confirm (default yes)
```

Fields are stable enough to become a self-service web form later (V2) — the intake email is V1's substitute for that form, not a permanent design.

---

## 4. Database schema (`store` schema)

```sql
-- One row per store location. chain_id/store_admin_id are added by
-- growayshop-registration-workflow.md §5 via ALTER TABLE, not here.
CREATE TABLE store.stores (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name             VARCHAR(200) NOT NULL,
    address          TEXT,
    timezone         VARCHAR(64)  NOT NULL DEFAULT 'America/Toronto',
    status           VARCHAR(20)  NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'suspended')),
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE store.staff (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id         UUID NOT NULL REFERENCES store.stores(id),
    name             VARCHAR(200) NOT NULL,
    phone            VARCHAR(20),
    email            VARCHAR(255),
    role             VARCHAR(50)  NOT NULL DEFAULT 'staff',  -- descriptive only, e.g. 'owner' | 'manager' | 'staff' | free text
    status           VARCHAR(20)  NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE store.services (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id         UUID NOT NULL REFERENCES store.stores(id),
    name             VARCHAR(200) NOT NULL,
    duration_minutes INT NOT NULL,
    price_cents      INT NOT NULL,
    price_type       VARCHAR(10) NOT NULL DEFAULT 'fixed' CHECK (price_type IN ('fixed', 'variable')),
    category         VARCHAR(100),
    status           VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE store.staff_services (
    staff_id    UUID NOT NULL REFERENCES store.staff(id),
    service_id  UUID NOT NULL REFERENCES store.services(id),
    PRIMARY KEY (staff_id, service_id)
);

CREATE TABLE store.staff_schedules (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    staff_id    UUID NOT NULL REFERENCES store.staff(id),
    day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),  -- 0 = Sunday
    start_time  TIME NOT NULL,
    end_time    TIME NOT NULL
);

CREATE TABLE store.staff_time_offs (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    staff_id    UUID NOT NULL REFERENCES store.staff(id),
    starts_at   TIMESTAMPTZ NOT NULL,
    ends_at     TIMESTAMPTZ NOT NULL,
    reason      VARCHAR(200),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE store.business_hours (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id    UUID NOT NULL REFERENCES store.stores(id),
    day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
    open_time   TIME,   -- NULL means closed that day
    close_time  TIME
);

CREATE TABLE store.booking_settings (
    store_id                UUID PRIMARY KEY REFERENCES store.stores(id),
    slot_granularity_minutes INT NOT NULL DEFAULT 15,
    advance_booking_days     INT NOT NULL DEFAULT 90,
    auto_confirm             BOOLEAN NOT NULL DEFAULT TRUE
);

-- customer_id is an application-level reference to customer.customers - never
-- an enforced FK (architecture doc §5). Quota enforcement (groway-billing-workflow.md
-- §4.2) runs as one additive internal call at the start of whatever creates this row.
CREATE TABLE store.appointments (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id      UUID NOT NULL REFERENCES store.stores(id),
    customer_id   UUID NOT NULL,  -- application-level reference to customer.customers.id
    staff_id      UUID NOT NULL REFERENCES store.staff(id),
    status        VARCHAR(20) NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'completed', 'cancelled', 'no_show')),
    starts_at     TIMESTAMPTZ NOT NULL,
    ends_at       TIMESTAMPTZ NOT NULL,
    is_test       BOOLEAN NOT NULL DEFAULT FALSE,  -- staff-marked test booking; see §5 on quota interaction
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE store.appointment_items (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    appointment_id  UUID NOT NULL REFERENCES store.appointments(id),
    service_id      UUID NOT NULL REFERENCES store.services(id),
    price_cents     INT NOT NULL  -- snapshot of the price at booking time, not a live join to services
);

CREATE INDEX idx_staff_store_id ON store.staff(store_id);
CREATE INDEX idx_services_store_id ON store.services(store_id);
CREATE INDEX idx_appointments_store_id_starts_at ON store.appointments(store_id, starts_at);
CREATE INDEX idx_appointments_customer_id ON store.appointments(customer_id);
```

---

## 5. `is_test` and the billing quota — the one place this document and `groway-billing-workflow.md` must stay in sync

`pricing-tiers-v1.md`'s billing rule excludes staff-marked test appointments from the Free-plan quota. That requires `store.appointments.is_test` (added above) to exist, and `groway-billing-workflow.md` §4.2's quota-check call to read it before deciding whether to consume a unit of quota. `is_test` is set by staff at creation time (a checkbox on the manual-booking screen) — never inferred.

---

## 6. APIs (unchanged in shape from the retired document, `merchant`→`store` renamed)

- **Back Office (Groway admin / chain_admin / store_admin), `/api/store/back-office/*`** — CRUD for stores, staff, services, staff↔service assignment, business hours, booking settings. Wireframes not reproduced here — same step-by-step wizard shape as before (basic info → services → staff → hours/rules → done), just relabeled "store" instead of "merchant."
- **Public booking, `/api/store/public/*`** — list a store's services/available slots, create an appointment (runs through `groway-billing-workflow.md` §4.2's quota check first).

---

## 7. Open questions

1. **Wireframe detail** was intentionally not reproduced at the same fidelity as the retired document — this is the schema/API contract; pixel-level Back Office UI can be redrawn separately if needed.
2. **Multi-service, multi-staff appointments** (`appointment_items` allows several service lines per appointment) — whether they can span more than one staff member per appointment isn't addressed here.
3. Everything else the retired document left open (proration, cross-store service catalogs, etc.) is not reintroduced here unless it resurfaces.
