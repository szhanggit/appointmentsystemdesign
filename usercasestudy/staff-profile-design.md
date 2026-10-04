# Staff Profile — Design

**Status:** V1. The public profile page (§2) and the admin-entry write path (§6.2). — 2026-10-03 (Steven): the self-service endpoint (§6.1), the review workflow (§6.3), and the `_pending` staging columns (§3) were REMOVED — staff have no access to the system (principle #1: no staff login/interface), so there is nothing staff-submitted left to review. Removed sections keep their numbers as dated placeholders; they were not renumbered. See the scope note immediately below before reading further. Builds on `store-onboarding-v1-design.md` §4 (`store.staff`, `staff_schedules`) and reuses `beauty-map-postgis-schema-design.md`'s platform-taxonomy pattern for spoken languages. Shares its photo table with `store-profile-enrichment-design.md` §2.2. Deep-links into `public-booking-end-to-end-design.md` §5.

> **Build scope note.** V1 ships the public page (§2) and `PUT /api/store/team/{staffId}` (§6.2) — every write to a staff member's profile (bio/photo/languages/title) is entered by `store_admin`/`chain_admin` on their behalf, straight to the live columns. — 2026-10-03 (Steven): the former V1.1 self-service/review/staging design (§6.1, §6.3, §3's `_pending` columns) was removed, not deferred — staff have no system access, so no staff-submitted content exists to stage or review. If a future staff portal ever needs moderation, it gets designed fresh then.

## 1. Decisions

1. **Public route, no login: `/s/{store_id}/team/{staff_id}`.** `404`s — not a generic error page with blank fields — unless the person has **≥1 live schedule entry** at that store (2026-10-03, Batch 4 — replaces Q1's assignment-status rule, since there is no assignment or status anymore; "works here" is the only test). A profile page represents *this person's relationship with customers at this store* (decision 10 below); zero live entries there means that relationship doesn't currently exist, and rendering the profile would advertise someone customers cannot book. Same same-store invariant as the photo table (`store-profile-enrichment-design.md` §2.2, same rule), and the same "never leak existence" rule used for every other cross-scope lookup in this project — still a plain `404`, never a `403` that would confirm the person exists at all.
2. **Content order**: photo, name, title, languages, bio, stats, portfolio, [Book them] CTA.
3. **One write endpoint: `PUT /api/store/team/{staffId}`** (`store_admin`/`chain_admin`, identifying which staff member by `{staffId}`: everything, including `title`), straight to the live columns. — 2026-10-03 (Steven): the former self-service endpoint (`PUT /api/store/team/me`) was removed — staff have no system access.
> **Decisions 4–7 removed 2026-10-03 (Steven):** the `_pending` staging columns, self-service merge-patch semantics, one-verdict review, and transient-`rejected` design — staff have no system access, so nothing is staged or reviewed. Numbers 4–7 are not reused.

8. **Stats are exact numbers by default**, with a `store_admin`-only hidden toggle to switch to a banded display ("500+") for a given person at a given store.
9. **Spoken-language tags are a separate taxonomy from the customer-notification-language system** (`en`/`zh` only). This one is a discovery signal — "can this person speak with me" — never consumed by SMS/email templates, and never reconciled with that other system.
10. **Per-store stats are permanent, not a v1.1 shortcut.** A profile page represents this person's relationship with customers *at this store*. A chain-wide aggregate, if it's ever built, belongs on a separate chain-level page — not folded into this one.

## 2. Public page content

- **Photo**: `photo_s3_key` — the live column; a placeholder avatar when `NULL`.
- **Name**: `store.staff.name`.
- **Title**: `store.staff.title` (nullable, ≤100 chars) — e.g. "Senior Nail Tech." Settable only by `store_admin`/`chain_admin` (decision 3) — it reads as pricing/positioning language, not something a staff member self-describes.
- **Languages**: `store.staff.languages` (array of platform-defined codes, §4). An empty array → the language row doesn't render at all (no "not specified").
- **Bio**: `bio_en`/`bio_zh` — the live columns (nullable, ≤500 chars each).
- **Stats**: §5's two numbers, exact by default.
- **Portfolio**: `store.store_photos` rows where `staff_id` = this person and `status='approved'` (`store-profile-enrichment-design.md` §2.2).
- **CTA**: [Book them] → `/book/{store_id}?staff_id=xxx` (`public-booking-end-to-end-design.md` §5) — staff preselected, still changeable inside the flow.

## 3. Schema

```sql
ALTER TABLE store.staff
  ADD COLUMN title                   VARCHAR(100),
  ADD COLUMN languages               TEXT[] NOT NULL DEFAULT '{}',   -- codes from platform.spoken_languages, §4
  -- Live columns - what the public page reads, period.
  ADD COLUMN photo_s3_key            TEXT,
  ADD COLUMN bio_en                  TEXT CHECK (char_length(bio_en) <= 500),
  ADD COLUMN bio_zh                  TEXT CHECK (char_length(bio_zh) <= 500),
  -- Submission-level status (decision 6) - covers whichever of the three
  -- staged columns above are currently non-NULL as one batch; not per-field.
```

> **Staging columns and `bio_status` removed 2026-10-03 (Steven)** — see the status note at the top. All profile writes go straight to the live columns (§6.2).

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
- **Store-scoped, not person-scoped**: both filters include `store_id = :store_id` **because `staff_id` alone would not narrow correctly** — `appointments.staff_id` is person-level, so a multi-store staff member's row would otherwise pull in appointments from every store they work at, not just this one. The `store_id` filter is what makes a staff member working at two stores in the same chain get two different, correct numbers on their two profile pages (by design, decision 10).
- A `store_admin`-only toggle (scoped to this person's stats display at this one store; exact storage left to implementation, since there is no per-store row to hang it off anymore — a small dedicated table or a `staff_services` column both work) switches between exact numbers and a banded form ("500+"); default is exact.

## 6. Store-side data entry

Lives on the existing back-office team page (`store-onboarding-v1-design.md` §7's area) — an extension of it, not a new page. A new staff member's profile starts empty; the public page renders no placeholder for any empty field ("bio coming soon," "no languages listed," etc.) — an empty field simply doesn't appear.

### 6.1 `PUT /api/store/team/me` — self-service

> **Removed 2026-10-03 (Steven):** staff have no system access (principle #1) — no self-service endpoint exists. All writes go through §6.2. Section number kept stable; not renumbered.

### 6.2 `PUT /api/store/team/{staffId}` — admin

`store_admin`/`chain_admin`, `storeId ∈ caller.AuthorizedStoreIds`. Writes **every** field, including `title`, straight to its **live** column — no staging, this call is the terminal authority. Merge-patch semantics: a field absent from the request body is left untouched.


### 6.3 Review actions

> **Removed 2026-10-03 (Steven):** no staff-submitted content exists to review (principle #1). Section number kept stable; not renumbered.

## 7. Test cases

1. `/s/{store_id}/team/{staff_id}` where the person has zero live schedule entries at that store → `404`, not a profile page with blank fields.
1a. Same route, where the person exists but has zero live schedule entries at that store (all soft-deleted, or never had any) → also `404` (2026-10-03, Batch 4) — indistinguishable from "this person doesn't exist at all," by design.
2. `languages = []` → the language row is absent from the rendered page, no error.
3. A test appointment, or any appointment at a store with `is_test=true`, never counts toward stats.
5. The same person, assigned to two stores in one chain, shows two independent stats totals on their two profile pages.
6. `title` is read-only in the self-service endpoint; only the admin endpoint can change it.

## 8. Non-goals (v1.1)

1. Staff accepting bookings individually — every appointment remains store-owned, never staff-owned.
2. A chain-wide aggregate stats view (decision 10; would live on a future chain-level page, not here).
3. Free-text language entry.
4. Rich-text bio editor.
