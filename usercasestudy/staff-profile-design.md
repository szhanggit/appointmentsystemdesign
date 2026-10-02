# Staff Profile — Design

**Status:** V1.1. The public, no-login staff profile page and its store-side data entry. Builds on `store-onboarding-v1-design.md` §4 (`store.staff`, `staff_store_assignments`) and reuses `beauty-map-postgis-schema-design.md`'s platform-taxonomy pattern for spoken languages. Shares its photo table with `store-profile-enrichment-design.md` §2.2. Deep-links into `public-booking-end-to-end-design.md` §5.

## 1. Decisions

1. **Public route, no login: `/s/{store_id}/team/{staff_id}`.** `404`s — not a generic error page with blank fields — when **no** `staff_store_assignments` row exists for that `(staff_id, store_id)` pair (the table has no `status` column — this is a plain existence check, not an active/inactive one). Same same-store invariant as the photo table (`store-profile-enrichment-design.md` §2.2), and the same "never leak existence" rule used for every other cross-scope lookup in this project.
2. **Content order**: photo, name, title, languages, bio, stats, portfolio, [Book them] CTA.
3. **Two write endpoints, not a field-level permission check on one.** `PUT /api/store/staff/me/profile` (self-service: bio, photo, languages, portfolio; sets `bio_status='pending'`) and `PUT /api/store/staff/{staffId}/profile` (`store_admin`/`chain_admin`, identifying which staff member by `{staffId}`: everything, including `title`). This reuses the project's existing scope-based authorization vocabulary (`storeId ∈ caller.AuthorizedStoreIds`, plus "is this your own staff row") instead of inventing a new field-level permission primitive.
4. **Stats are exact numbers by default**, with a `store_admin`-only hidden toggle to switch to a banded display ("500+") for a given assignment.
5. **Spoken-language tags are a separate taxonomy from the customer-notification-language system** (`en`/`zh` only). This one is a discovery signal — "can this person speak with me" — never consumed by SMS/email templates, and never reconciled with that other system.
6. **Per-store stats are permanent, not a v1.1 shortcut.** A profile page represents this person's relationship with customers *at this store*. A chain-wide aggregate, if it's ever built, belongs on a separate chain-level page — not folded into this one.

## 2. Public page content

- **Photo**: `photo_s3_key` (nullable); a placeholder avatar when absent.
- **Name**: `store.staff.name`.
- **Title**: `store.staff.title` (nullable, ≤100 chars) — e.g. "Senior Nail Tech." Settable only by `store_admin`/`chain_admin` (decision 3) — it reads as pricing/positioning language, not something a staff member self-describes.
- **Languages**: `store.staff.languages` (array of platform-defined codes, §4). An empty array → the language row doesn't render at all (no "not specified").
- **Bio**: `bio_en`/`bio_zh` (nullable, ≤500 chars each) — only the currently-approved version is ever shown publicly (§3).
- **Stats**: §5's two numbers, exact by default.
- **Portfolio**: `store.store_photos` rows where `staff_id` = this person and `status='approved'` (`store-profile-enrichment-design.md` §2.2).
- **CTA**: [Book them] → `/book/{store_id}?staff_id=xxx` (`public-booking-end-to-end-design.md` §5) — staff preselected, still changeable inside the flow.

## 3. Schema

```sql
ALTER TABLE store.staff
  ADD COLUMN title               VARCHAR(100),
  ADD COLUMN photo_s3_key        TEXT,
  ADD COLUMN languages           TEXT[] NOT NULL DEFAULT '{}',   -- codes from platform.spoken_languages, §4
  ADD COLUMN bio_en              TEXT CHECK (char_length(bio_en) <= 500),
  ADD COLUMN bio_zh              TEXT CHECK (char_length(bio_zh) <= 500),
  ADD COLUMN bio_status          VARCHAR(20) NOT NULL DEFAULT 'approved'
                                   CHECK (bio_status IN ('pending','approved','rejected')),
  ADD COLUMN bio_rejection_reason TEXT;
```

- `bio_status` defaults to `approved` (an empty bio needs no review). It flips to `pending` whenever the staff member edits their own bio via the self-service endpoint (decision 3), and a `store_admin` moves it to `approved`/`rejected` inline on the team page — no separate moderation queue; one bio per language per person is low enough volume to review alongside the rest of the roster, unlike the Groway-wide photo queue (`store-profile-enrichment-design.md` §4).
- No separate bio-moderation table: a single status column on `store.staff` is sufficient since there's exactly one current bio per language, never a list of historical submissions to track.

## 4. Language taxonomy

```sql
CREATE TABLE platform.spoken_languages (
  code       VARCHAR(10) PRIMARY KEY,   -- BCP 47
  name_en    VARCHAR(64) NOT NULL,
  name_zh    VARCHAR(64) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0
);

INSERT INTO platform.spoken_languages (code, name_en, name_zh, sort_order) VALUES
  ('en',  'English',   '英语',     10),
  ('cmn', 'Mandarin',  '普通话',   20),
  ('yue', 'Cantonese', '粤语',     30),
  ('fr',  'French',    '法语',     40),
  ('ko',  'Korean',    '韩语',     50),
  ('es',  'Spanish',   '西班牙语', 60);
```

- `store.staff.languages` stores an array of these codes, never free text — a multi-select chip picker in the UI, not a text field.
- Growing the list is a Groway-admin action on `platform.spoken_languages`, the same ownership pattern as `platform.category_taxonomy` (`beauty-map-postgis-schema-design.md` §3) — a store can't add its own entries.
- Deliberately separate from `customer.customers.language` / `booking_settings.notification_lang` (`en`/`zh` only): this taxonomy answers "who can this person talk to," not "what language does this customer's SMS use." The two are never cross-referenced.

## 5. Stats (definition fixed, not left to implementation discretion)

- **Completed bookings**: `COUNT(*) FROM store.appointments WHERE staff_id = :staff_id AND store_id = :store_id AND status = 'completed' AND is_test = false AND <that store's is_test = false>`. Only `completed` counts — not `confirmed`, not `no_show`.
- **Customers served**: `COUNT(DISTINCT customer_id)` under the same filter. Guest bookings (`customer_id IS NULL`) aren't counted — a guest never gets a `customer.customers` row (`customer-records-design.md` §3), so there's nothing distinct to count. This is a known undercount for guest-heavy stores, not a bug to fix here.
- Computed live on page load in v1.1 — volume is low enough; a cached counter is a later optimization, not designed here.
- **Store-scoped, not person-scoped**: both filters include `store_id = :store_id` **because `staff_id` alone would not narrow correctly** — `appointments.staff_id` is person-level, so a multi-store staff member's row would otherwise pull in appointments from every store they work at, not just this one. The `store_id` filter is what makes a staff member working at two stores in the same chain get two different, correct numbers on their two profile pages (by design, decision 6).
- A `store_admin`-only toggle (scoped to the `staff_store_assignments` row; exact column left to implementation) switches that assignment's display between exact numbers and a banded form ("500+"); default is exact.

## 6. Store-side data entry

- Lives on the existing back-office team page (`store-onboarding-v1-design.md` §7's area) — an extension of it, not a new page.
- **Self-service** (`PUT /api/store/staff/me/profile`): the staff member edits their own photo, languages, bio, and portfolio uploads (into `store.store_photos` with their own `staff_id`, per `store-profile-enrichment-design.md` §2.2). Saving a bio sets `bio_status='pending'`.
- **Admin** (`PUT /api/store/staff/{staffId}/profile`): `store_admin`/`chain_admin` can edit everything for the staff member identified by `{staffId}`, including `title`, and inline-approve/reject a pending bio on the same page.
- A new staff member's profile starts empty; the public page renders no placeholder for any empty field ("bio coming soon," "no languages listed," etc.) — an empty field simply doesn't appear.

## 7. Test cases

1. `/s/{store_id}/team/{staff_id}` where no `staff_store_assignments` row exists for that pair → `404`, not a profile page with blank fields.
2. `languages = []` → the language row is absent from the rendered page, no error.
3. A test appointment, or any appointment at a store with `is_test=true`, never counts toward stats.
4. A staff member edits their own `bio_en` → `bio_status` flips to `pending`; the public page keeps showing the previously-approved version until a `store_admin` approves the new one.
5. The same person, assigned to two stores in one chain, shows two independent stats totals on their two profile pages.
6. `title` is read-only in the self-service endpoint; only the admin endpoint can change it.

## 8. Non-goals (v1.1)

1. Staff accepting bookings individually — every appointment remains store-owned, never staff-owned.
2. A chain-wide aggregate stats view (decision 6; would live on a future chain-level page, not here).
3. Free-text language entry.
4. Rich-text bio editor.
