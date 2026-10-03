# Staff Profile — Design

**Status:** split (2026-10-02 digest ruling). The public profile page (§2) and the admin-entry write path (§6.2) are **V1**. Self-service (§6.1), the review workflow (§6.3), and the `_pending` staging columns (§3) are **V1.1**. See the scope note immediately below before reading further. Builds on `store-onboarding-v1-design.md` §4 (`store.staff`, `staff_schedules`) and reuses `beauty-map-postgis-schema-design.md`'s platform-taxonomy pattern for spoken languages. Shares its photo table with `store-profile-enrichment-design.md` §2.2. Deep-links into `public-booking-end-to-end-design.md` §5.

> **Build scope note (2026-10-02).** V1 ships the public page (§2) and `PUT /api/store/team/{staffId}` (§6.2) only — every V1 write to a staff member's profile (bio/photo/languages/title) is entered by `store_admin`/`chain_admin` on their behalf, straight to the live columns. `PUT /api/store/team/me` (§6.1, self-service), the review endpoints (§6.3), and the `_pending`/`bio_status` staging columns (§3) are all **V1.1** — the self-service API design below is correct and ready, but it has no caller in V1: no staff-facing "My Profile" page was ever designed, and building the write path without the page it's called from would ship dead code. Designing that page (login landing → navigation → the form itself) is the prerequisite for the V1.1 build, and it will also serve as the first screen of the V2 staff self-service portal already noted in `V1Backlog.md`. **Boundary:** this split covers profile fields only (bio/photo/languages/title) — staff self-service for schedule/time-off is `staff-schedule-entry-workflow.md`'s separate concern and is unaffected; "self-service preferred" still stands there.

## 1. Decisions

1. **Public route, no login: `/s/{store_id}/team/{staff_id}`.** `404`s — not a generic error page with blank fields — unless the person has **≥1 live schedule entry** at that store (2026-10-03, Batch 4 — replaces Q1's assignment-status rule, since there is no assignment or status anymore; "works here" is the only test). A profile page represents *this person's relationship with customers at this store* (decision 10 below); zero live entries there means that relationship doesn't currently exist, and rendering the profile would advertise someone customers cannot book. Same same-store invariant as the photo table (`store-profile-enrichment-design.md` §2.2, same rule), and the same "never leak existence" rule used for every other cross-scope lookup in this project — still a plain `404`, never a `403` that would confirm the person exists at all.
2. **Content order**: photo, name, title, languages, bio, stats, portfolio, [Book them] CTA.
3. **Two write endpoints, not a field-level permission check on one.** `PUT /api/store/team/me` (self-service: bio, photo, languages, portfolio) and `PUT /api/store/team/{staffId}` (`store_admin`/`chain_admin`, identifying which staff member by `{staffId}`: everything, including `title`). This reuses the project's existing scope-based authorization vocabulary (`storeId ∈ caller.AuthorizedStoreIds`, plus "is this your own staff row") instead of inventing a new field-level permission primitive — a field-level role check would be the project's first such primitive, and the blast radius of getting that wrong isn't worth it just to let a store_admin review a title in the same call as a bio.
4. **Bio and avatar are staged (`_pending` columns), never overwrite the live value directly — languages aren't, and publish immediately.** A free-text bio or a photo needs review before the public page shows it; `languages` is a closed enum pick with no free-text risk, so it skips the gate entirely. One self-service `PUT` call can therefore write some fields straight to `live` (`languages`) and others only to `_pending` (`bio_en`, `bio_zh`, `photo_s3_key`) — a deliberately mixed semantics, written down explicitly so an implementer doesn't "simplify" it into one path (§6).
5. **The self-service endpoint is merge-patch, not replace-everything.** A field absent from the request body is left untouched — including an already-in-flight `_pending` value the client's own form never showed it. A strict PUT (absent = clear) would force the client to resend the entire profile every time and would silently destroy pending work the staff member can't even see happening (§6).
6. **One review verdict per submission, never split per field.** Approving or rejecting always acts on the *entire* current set of non-null `_pending` columns at once — not "English passes, Chinese doesn't." A single `bio_status` column can't represent a mixed outcome; supporting that would mean building a field-level moderation state machine, which this decision explicitly declines. A reviewer who wants a split outcome rejects the whole batch and says which part was fine in the rejection reason — the staff member only resubmits the part that needs fixing (§6).
7. **`rejected` is a transient notification, not a resting state.** Its only job is "your last submission was rejected, here's why, go deal with it." Dealing with it — resubmitting (back to `pending`) or explicitly withdrawing (back to `approved`, §6) — always clears `bio_rejection_reason`. A `rejected` row with nothing left pending behind it is a zombie state that claims something was rejected without being able to say what, given there's no history table to point back to.
8. **Stats are exact numbers by default**, with a `store_admin`-only hidden toggle to switch to a banded display ("500+") for a given person at a given store.
9. **Spoken-language tags are a separate taxonomy from the customer-notification-language system** (`en`/`zh` only). This one is a discovery signal — "can this person speak with me" — never consumed by SMS/email templates, and never reconciled with that other system.
10. **Per-store stats are permanent, not a v1.1 shortcut.** A profile page represents this person's relationship with customers *at this store*. A chain-wide aggregate, if it's ever built, belongs on a separate chain-level page — not folded into this one.

## 2. Public page content

- **Photo**: `photo_s3_key` — **the live column, never `photo_s3_key_pending`** (§3/§6); a placeholder avatar when `NULL`.
- **Name**: `store.staff.name`.
- **Title**: `store.staff.title` (nullable, ≤100 chars) — e.g. "Senior Nail Tech." Settable only by `store_admin`/`chain_admin` (decision 3) — it reads as pricing/positioning language, not something a staff member self-describes.
- **Languages**: `store.staff.languages` (array of platform-defined codes, §4). An empty array → the language row doesn't render at all (no "not specified").
- **Bio**: `bio_en`/`bio_zh` — **the live columns only** (nullable, ≤500 chars each). The public page never reads `bio_en_pending`/`bio_zh_pending` under any circumstance, regardless of `bio_status` — a pending or rejected submission is invisible here by construction, not by a query filter that could be gotten wrong (§3/§6).
- **Stats**: §5's two numbers, exact by default.
- **Portfolio**: `store.store_photos` rows where `staff_id` = this person and `status='approved'` (`store-profile-enrichment-design.md` §2.2).
- **CTA**: [Book them] → `/book/{store_id}?staff_id=xxx` (`public-booking-end-to-end-design.md` §5) — staff preselected, still changeable inside the flow.

## 3. Schema

```sql
ALTER TABLE store.staff
  ADD COLUMN title                   VARCHAR(100),
  ADD COLUMN languages               TEXT[] NOT NULL DEFAULT '{}',   -- codes from platform.spoken_languages, §4; always live, never staged (decision 4)
  -- Live columns - what the public page reads, period.
  ADD COLUMN photo_s3_key            TEXT,
  ADD COLUMN bio_en                  TEXT CHECK (char_length(bio_en) <= 500),
  ADD COLUMN bio_zh                  TEXT CHECK (char_length(bio_zh) <= 500),
  -- Staged columns - a self-edit lands here, never in the live column above,
  -- until a store_admin approves it (decision 4/§6). Same ≤500 limit as their
  -- live counterparts; photo has no separate size cap beyond store-profile-
  -- enrichment-design.md's upload limits.
  ADD COLUMN bio_en_pending          TEXT CHECK (char_length(bio_en_pending) <= 500),
  ADD COLUMN bio_zh_pending          TEXT CHECK (char_length(bio_zh_pending) <= 500),
  ADD COLUMN photo_s3_key_pending    TEXT,
  -- Submission-level status (decision 6) - covers whichever of the three
  -- staged columns above are currently non-NULL as one batch; not per-field.
  ADD COLUMN bio_status              VARCHAR(20) NOT NULL DEFAULT 'approved'
                                       CHECK (bio_status IN ('pending','approved','rejected')),
  ADD COLUMN bio_rejection_reason     TEXT;
```

- `bio_status` defaults to `approved` (nothing pending, nothing to review). It's a **submission-level** status, not per-column: it covers whatever subset of `bio_en_pending`/`bio_zh_pending`/`photo_s3_key_pending` happens to be set at a given moment, reviewed as one atomic batch (decision 6) — a `store_admin` moves the whole batch to `approved`/`rejected` inline on the team page, no separate moderation queue (one bio+photo submission per person is low enough volume to review alongside the rest of the roster, unlike the Groway-wide photo queue, `store-profile-enrichment-design.md` §4).
- **`""` (empty string) and `NULL` are different signals on the staged columns, never interchangeable** (§6): `""` staged in a `_pending` column is a real submission — "I propose deleting this" — and goes through the same review as any other edit; only on *approval* does the copy-to-live step write `NULL` instead of the literal `""` (this project has exactly one way to represent "nothing here" in a live column, and it's `NULL` — not two). `NULL` written directly to a `_pending` column by the client is a withdrawal, not a proposal (§6) — it never reaches a live column at all.
- No separate bio-moderation table: these columns on `store.staff` are sufficient since there's exactly one current (and one staged) bio per language per person, never a list of historical submissions to track — `rejected` is explicitly not meant to be a durable record (decision 7).

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

Body carries any subset of `{ photo_s3_key, bio_en, bio_zh, languages }` (plus portfolio uploads into `store.store_photos` with the caller's own `staff_id`, per `store-profile-enrichment-design.md` §2.2). **Merge-patch semantics** (decision 5) — for every field, three distinct signals:

| In request body | Meaning |
|---|---|
| Field absent | Untouched — including an in-flight `_pending` value the client never mentioned |
| Field = `""` (bio/photo only) | A real submission proposing to clear it — stages into the `_pending` column, goes through review like any other edit |
| Field = `null` (bio/photo only) | Withdraws whatever is currently staged for that field — clears that one `_pending` column, doesn't touch the live column (it was never touched in the first place) |
| Field = a value (bio/photo) | Stages into the matching `_pending` column |
| Field = a value or `null`/`[]` (`languages` only) | Written straight to the **live** `languages` column, immediately — decision 4, no staging, no review |

- Writing to any of `bio_en`/`bio_zh`/`photo_s3_key` only ever touches that field's own `_pending` column — the live column is never written by this endpoint.
- After applying the request: if `bio_status` was `pending` or `rejected` and at least one `_pending` column is still non-`NULL`, `bio_status` becomes (or stays) `pending`, and `bio_rejection_reason` is cleared (resubmission after a rejection — decision 7). If the `_pending` set becomes entirely empty (every field withdrawn via `null`, or there was nothing staged to begin with), `bio_status` becomes `approved` regardless of what it was before — including from `rejected` (decision 7: a `rejected` row with nothing left pending is a zombie, not a valid resting state).
- `languages` writes never touch `bio_status` at all — they're not part of the moderated batch.

### 6.2 `PUT /api/store/team/{staffId}` — admin

`store_admin`/`chain_admin`, `storeId ∈ caller.AuthorizedStoreIds`. Writes **every** field, including `title`, straight to its **live** column — no staging, this call is the terminal authority. Same merge-patch semantics as §6.1 (absent = untouched).

- **Writing live `bio_en`/`bio_zh`/`photo_s3_key` here clears that field's own `_pending` column**, if any. An admin's direct write is a final decision about what the public page shows; leaving a stale `_pending` value sitting there would mean the *next* approval silently overwrites the admin's edit with an outdated proposal — a silent rollback, worse than a bug because nothing would look wrong until it happened. If clearing a `_pending` column this way empties the whole staged set, `bio_status` goes to `approved` the same as §6.1's withdrawal case; any *other* field's `_pending` value is untouched.
- `title` has no self-service counterpart at all (decision 3) — not a field-level block on a shared endpoint, simply no endpoint gives a staff member a way to call it.

### 6.3 Review actions

```
POST /api/store/team/{staffId}/bio/approve
POST /api/store/team/{staffId}/bio/reject   { reason }
```

`store_admin`/`chain_admin` only; acts on the **entire current `_pending` batch** as one atomic verdict (decision 6) — there is no way to approve `bio_en_pending` while rejecting `bio_zh_pending` in the same call.

- **Approve**: for each of `bio_en_pending`/`bio_zh_pending`/`photo_s3_key_pending` that's non-`NULL`, copy it to the matching live column — **normalizing `""` to `NULL`** on the way (a staged "please delete this" becomes an actual empty live column, never a live `""`; §3) — then clear all three `_pending` columns. Sets `bio_status='approved'` and, defensively, clears `bio_rejection_reason` even though the normal flow should already have it empty (belt-and-suspenders against any path that forgot to clear it, rather than trusting every future code path to remember).
- **Reject**: clears all three `_pending` columns (no live column is ever touched by a rejection) and writes `bio_rejection_reason`. Sets `bio_status='rejected'` — a transient notification (decision 7), resolved by the staff member either resubmitting (§6.1, back to `pending`) or withdrawing (§6.1, back to `approved`).
- A reviewer who wants to split a mixed outcome (e.g. the English bio is fine, the Chinese one isn't) rejects the whole batch, writes the split into `reason` (e.g. "English is fine, please redo the Chinese version"), and the staff member resubmits only the part that needs it (decision 6). The informal alternative — approve the batch, then use §6.2 to hand-overwrite the one bad field — exists but counts as the admin writing the staff member's bio for them; not part of the normal flow.

## 7. Test cases

1. `/s/{store_id}/team/{staff_id}` where the person has zero live schedule entries at that store → `404`, not a profile page with blank fields.
1a. Same route, where the person exists but has zero live schedule entries at that store (all soft-deleted, or never had any) → also `404` (2026-10-03, Batch 4) — indistinguishable from "this person doesn't exist at all," by design.
2. `languages = []` → the language row is absent from the rendered page, no error.
3. A test appointment, or any appointment at a store with `is_test=true`, never counts toward stats.
4. A staff member edits their own `bio_en` → `bio_status` flips to `pending`, `bio_en_pending` is set; the public page keeps showing the live `bio_en` (previously-approved or empty) until a `store_admin` approves the new one.
5. The same person, assigned to two stores in one chain, shows two independent stats totals on their two profile pages.
6. `title` is read-only in the self-service endpoint; only the admin endpoint can change it.
7. Staff submits `bio_en` (→ `bio_en_pending` set, `bio_status='pending'`). Before review, staff calls `PUT .../me` again with only `photo_s3_key` in the body → `bio_en_pending` is untouched, `photo_s3_key_pending` is now also set, `bio_status` stays `pending` covering both.
8. Staff submits `bio_en=""` → stages into `bio_en_pending` as `""`, goes to `pending`, same as any other edit. Approved → live `bio_en` becomes `NULL`, not `""`. The public page renders no bio line either way, but the live column itself is never `""`.
9. Staff submits `bio_en`, then — before review — submits `bio_en: null` → `bio_en_pending` clears; if no other field is staged, `bio_status` reverts to `approved` and the live `bio_en` (whatever it was before) is untouched, since it was never written.
10. Rejected submission (`bio_status='rejected'`, `bio_rejection_reason` set): staff resubmits `bio_zh` → `bio_status` back to `pending`, `bio_rejection_reason` cleared. Alternatively, staff submits `bio_zh: null` (withdraw, no resubmission) → `bio_status` back to `approved`, `bio_rejection_reason` cleared, live content untouched either way.
11. `store_admin` rejects a batch containing both `bio_en_pending` and `bio_zh_pending` → both clear, `bio_status='rejected'`, one shared `bio_rejection_reason` — there is no way to accept one language and reject the other in this single call.
12. Staff has `bio_en_pending` set (awaiting review). `store_admin` uses the admin endpoint to write `bio_en` directly → `bio_en_pending` clears as a side effect (the admin's write is terminal); if that was the only staged field, `bio_status` returns to `approved`. A later approve action can no longer resurrect the staff member's stale proposal over the admin's edit.
13. Approving a batch always clears `bio_rejection_reason`, even in the (should-never-happen) case where it was non-empty going in.
14. `languages` edited via `PUT .../me` → written to the live column immediately, no effect on `bio_status`, regardless of whether a bio/photo edit is also pending at the time.

## 8. Non-goals (v1.1)

1. Staff accepting bookings individually — every appointment remains store-owned, never staff-owned.
2. A chain-wide aggregate stats view (decision 10; would live on a future chain-level page, not here).
3. Free-text language entry.
4. Rich-text bio editor.
