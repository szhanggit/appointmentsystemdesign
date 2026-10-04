# Staff Profile — Design

**Status:** admin-entry only — the public profile page (§2) and the admin-entry write path (§6.2). Builds on `store-onboarding-v1-design.md` §4 (`store.staff`, `staff_schedules`) and reuses `beauty-map-postgis-schema-design.md`'s platform-taxonomy pattern for spoken languages. Shares its photo table with `store-profile-enrichment-design.md` §2.2. Deep-links into `public-booking-end-to-end-design.md` §5.

> **Review workflow removed, 2026-10-03 (Steven, #21).** The earlier "split" framing (V1 admin-entry / V1.1 self-service-with-review) is retired along with the review machinery itself: per principle #1 (staff never touch the system in V1, no staff login, no staff-facing write path), there is no staff-submitted content to stage or review — the self-service endpoint (old §6.1), the approve/reject actions (old §6.3), the `_pending` staging columns and `bio_status` (old §3), and decisions 4–7 are all removed, not deferred. Section numbering below is kept stable rather than renumbered (so `#12`/`#20`'s references to §5 and decision 10 still land correctly) — removed items are marked in place with a dated note, not silently deleted from the outline. **If a future staff portal needs moderation, it gets redesigned fresh at that time** — this document does not try to half-preserve a mechanism with no caller.

## 1. Decisions

0. **Staff preview, admin-session (NEW, 2026-10-03, #19) — a stronger case than the store preview (`beauty-map-ui-design.md` §5).** A preview button per row on the team page, and on the profile edit page, opens this exact public URL. Since decision 1 below 404s this route unless the person has ≥1 live schedule entry at the store, a **newly added technician with no shifts yet** is exactly the moment preview is most needed and the public URL is least usable — without this, there's no way for an admin to see what the page will look like before it's actually live. Same session-based ribbon pattern as the store preview: that person's own `store_admin`/`chain_admin` see a "Preview mode" ribbon instead of the 404 everyone else gets. Stats (§5) show real numbers — `0` for a brand-new staff member, not a placeholder.
1. **Public route, no login: `/s/{store_id}/team/{staff_id}`.** `404`s — not a generic error page with blank fields — unless the person has **≥1 live schedule entry** at that store (2026-10-03, Batch 4 — replaces Q1's assignment-status rule, since there is no assignment or status anymore; "works here" is the only test). A profile page represents *this person's relationship with customers at this store* (decision 10 below); zero live entries there means that relationship doesn't currently exist, and rendering the profile would advertise someone customers cannot book. Same same-store invariant as the photo table (`store-profile-enrichment-design.md` §2.2, same rule), and the same "never leak existence" rule used for every other cross-scope lookup in this project — still a plain `404`, never a `403` that would confirm the person exists at all.
2. **Content order**: photo, name, title, languages, bio, stats, portfolio, [Book them] CTA.
3. **One write endpoint: `PUT /api/store/team/{staffId}`** (`store_admin`/`chain_admin`, identifying which staff member by `{staffId}`: everything, including `title`, straight to live columns). *(2026-10-03, #21: the "two write endpoints" framing is removed along with the self-service endpoint — see the removal note above. What remains of this decision's reasoning: `storeId ∈ caller.AuthorizedStoreIds` is still the authorization check, no field-level permission primitive needed, since there is now only one writer and no "whose submission is this" question to arbitrate.)*
4. ~~Bio and avatar are staged (`_pending` columns)...~~ — **removed 2026-10-03 (#21).** No staging, no review gate: every admin write lands directly on the live column. There is no self-service writer for this to protect against.
5. ~~The self-service endpoint is merge-patch...~~ — **removed 2026-10-03 (#21).** §6.2's admin endpoint keeps its own merge-patch semantics (absent = untouched) on ordinary grounds — not needing to resend the whole profile every call — but the staging-specific reasoning this decision described no longer applies to anything.
6. ~~One review verdict per submission, never split per field~~ — **removed 2026-10-03 (#21).** No review action exists to need this rule.
7. ~~`rejected` is a transient notification, not a resting state~~ — **removed 2026-10-03 (#21).** No `bio_status` column, no rejected state.
8. **Stats are exact numbers by default**, with a `store_admin`-only hidden toggle to switch to a banded display ("500+") for a given person, chain-wide (2026-10-03, decision 10 below).
9. **Spoken-language tags are a separate taxonomy from the customer-notification-language system.** This one is a discovery signal — "can this person speak with me" — never consumed by SMS/email templates. *(2026-10-03, #22: the customer-notification-language system itself is retired — V1 is English-only — so this is now a comparison to a system that no longer exists; the taxonomy stands on its own as a discovery feature, display names English-only, §4.)*
10. ~~Per-store stats are permanent, not a v1.1 shortcut...~~ — **reversed 2026-10-03 (Steven, #20): stats are chain-wide, not per-store.** Consistent with principle #2 (contract and timetable are chain-level) — the per-store split was a scheduling artifact, not a performance signal; a customer reading "500 completed" gets a sense of experience, "120 at this store" is noise. A profile page now represents this person's relationship with customers **across the whole chain**; a per-store breakdown is drill-down detail for staffing decisions (§5), never the headline. Stats stay per-chain — no cross-chain aggregation.

## 2. Public page content

- **Photo**: `photo_s3_key` (admin-entered only, §6.2); a placeholder avatar when `NULL`.
- **Name**: `store.staff.name`.
- **Title**: `store.staff.title` (nullable, ≤100 chars) — e.g. "Senior Nail Tech." Settable only by `store_admin`/`chain_admin` (decision 3) — it reads as pricing/positioning language, not something a staff member self-describes.
- **Languages**: `store.staff.languages` (array of platform-defined codes, §4). An empty array → the language row doesn't render at all (no "not specified").
- **Bio**: `bio` — **a single English field** (nullable, ≤500 chars; 2026-10-03, #22 — `bio_zh` dropped, V1 is English-only, no i18n framework, no translated content anywhere in the product), admin-entered only (§6.2).
- **Stats (2026-10-03, #20 — now chain-wide, not per-store)**: §5's numbers — completed-booking count and the "most-requested" specified-booking count (#12), both summed across every store in the chain.
- **Portfolio**: `store.store_photos` rows where `staff_id` = this person and `status='approved'` (`store-profile-enrichment-design.md` §2.2).
- **CTA**: [Book them] → `/book/{store_id}?staff_id=xxx` (`public-booking-end-to-end-design.md` §5) — staff preselected, still changeable inside the flow.

## 3. Schema

**2026-10-03 removal note (#21 + #22):** the `_pending` staging columns, `bio_status`, and `bio_rejection_reason` are removed — no self-service writer exists to stage anything, so there is nothing to review. `bio_zh` is also removed (#22, English-only V1) — `bio_en` is renamed to plain `bio`.

```sql
ALTER TABLE store.staff
  ADD COLUMN title       VARCHAR(100),
  ADD COLUMN languages   TEXT[] NOT NULL DEFAULT '{}',   -- codes from platform.spoken_languages, §4
  ADD COLUMN photo_s3_key TEXT,
  ADD COLUMN bio         TEXT CHECK (char_length(bio) <= 500);  -- 2026-10-03: renamed from bio_en, bio_zh dropped (#22)
```

Every field here is admin-entered only (§6.2) — one live value per field, written directly, no staging and no moderation state to track.

## 4. Language taxonomy

```sql
-- name_zh DROPPED 2026-10-03 (#22, V1 is English-only). Internal BCP-47
-- codes stay (data, not display) - KEPT per Steven's explicit confirmation,
-- 2026-10-03 ~22:55: spoken-language tags remain, displayed in English only
-- ("Speaks: Mandarin / Cantonese"); only the Chinese display-name column is gone.
CREATE TABLE platform.spoken_languages (
  code       VARCHAR(10) PRIMARY KEY,   -- BCP 47
  name_en    VARCHAR(64) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0
);

INSERT INTO platform.spoken_languages (code, name_en, sort_order) VALUES
  ('en',  'English',   10),
  ('cmn', 'Mandarin',  20),
  ('yue', 'Cantonese', 30),
  ('fr',  'French',    40),
  ('ko',  'Korean',    50),
  ('es',  'Spanish',   60);
```

- `store.staff.languages` stores an array of these codes, never free text — a multi-select chip picker in the UI, not a text field.
- Growing the list is a Groway-admin action on `platform.spoken_languages`, the same ownership pattern as `platform.category_taxonomy` (`beauty-map-postgis-schema-design.md` §3) — a store can't add its own entries.
- **2026-10-03 (#22): there is no longer a separate "customer-notification-language system" to stay independent from** — `customer.customers.language`/`booking_settings.notification_lang` are both dropped (V1 is English-only). This taxonomy now stands alone as a discovery signal ("who can this person talk to"), English display names only — never translated, never reconciled with anything else, because there's nothing else left to reconcile with.

## 5. Stats — chain-wide (2026-10-03, #20 reverses decision 10's original per-store scoping)

- **Completed bookings**: `COUNT(*) FROM store.appointments a JOIN store.stores s ON s.id = a.store_id WHERE a.staff_id = :staff_id AND s.chain_id = :chain_id AND a.status = 'completed'`. Only `completed` counts — not `confirmed`, not `no_show`. `is_test` filtering — design retained, **deferred from the V1 build** (#18, `V1Backlog.md`); the V1 query has no `is_test` clause at all.
- **Most-requested / specified-booking count (NEW, 2026-10-03, #12/#20)**: `COUNT(*) FROM store.appointments a JOIN store.stores s ON s.id = a.store_id WHERE a.staff_id = :staff_id AND s.chain_id = :chain_id AND a.staff_specified = true AND a.status = 'completed'`. `staff_specified` is a new `appointments` column (`create-appointment-transaction-design.md` §1, #12) — `TRUE` only when a public-channel create carried an explicit customer-chosen `staff_id` (a Step-2 pick or a `?staff_id=` deep link from this very profile page), derived at `INSERT` time from the request. `FALSE` for "any available" (server-resolved) and for staff-manual bookings. Only `completed` counts here too — a no-show doesn't make anyone popular. This is the number that powers the "redder gets redder" flywheel: profile → [Book them] CTA → more specified bookings → a higher number next time someone looks.
- **Customers served**: `COUNT(DISTINCT customer_id)` under the completed-bookings filter (chain-wide, same join). Guest bookings (`customer_id IS NULL`) aren't counted — a guest never gets a `customer.customers` row (`customer-records-design.md` §3), so there's nothing distinct to count. This is a known undercount for guest-heavy stores, not a bug to fix here.
- Computed live on page load — volume is low enough; a cached counter is a later optimization, not designed here.
- **Chain-scoped, not store-scoped (reversed 2026-10-03, #20)**: every filter above joins through `s.chain_id`, not `store_id` — a multi-store staff member's numbers are now the sum across every store they work at in the chain, not split per store. The same person at two stores in one chain shows the **same** total on both of their profile pages (the opposite of the old per-store behavior) — rationale in decision 10.
- **Per-store breakdown exists only as drill-down**, never the headline (#20) — a chain-owner dashboard or a staffing-decision view can show the store-by-store split for operational purposes; the public profile page and any customer-facing leaderboard show chain-wide numbers only.
- **Chain-owner dashboard: chain-wide most-requested leaderboard (NEW, 2026-10-03, #20)** — ranks staff by the specified-booking count above, chain-wide. Back-office feature, not designed in further UI detail here.
- A `store_admin`-only toggle (now scoped to this person's stats display **chain-wide**, not per-store-per-person; exact storage left to implementation) switches between exact numbers and a banded form ("500+"); default is exact.

## 6. Store-side data entry

Lives on the existing back-office team page (`store-onboarding-v1-design.md` §7's area) — an extension of it, not a new page. A new staff member's profile starts empty; the public page renders no placeholder for any empty field ("bio coming soon," "no languages listed," etc.) — an empty field simply doesn't appear.

### 6.1 ~~`PUT /api/store/team/me` — self-service~~ — removed 2026-10-03 (#21)

Per principle #1 (staff never touch the system in V1), there is no staff login and no staff-facing write path — this endpoint does not exist in V1. If a future staff portal is built, this is redesigned fresh at that time rather than resurrected as-was.

### 6.2 `PUT /api/store/team/{staffId}` — admin

`store_admin`/`chain_admin`, `storeId ∈ caller.AuthorizedStoreIds`. Writes **every** field — `title`, `photo_s3_key`, `bio`, `languages` — straight to its live column. Merge-patch semantics (absent = untouched); every write is immediate and terminal, no staging, no approval step.

### 6.3 ~~Review actions~~ — removed 2026-10-03 (#21)

No `_pending` columns, no `bio_status`, nothing to approve or reject. §6.2 is the only write path and it is immediately live.

## 7. Test cases

1. `/s/{store_id}/team/{staff_id}` where the person has zero live schedule entries at that store → `404`, not a profile page with blank fields.
1a. Same route, where the person exists but has zero live schedule entries at that store (all soft-deleted, or never had any) → also `404` (2026-10-03, Batch 4) — indistinguishable from "this person doesn't exist at all," by design.
2. `languages = []` → the language row is absent from the rendered page, no error.
3. `is_test` filtering of stats — design retained, **deferred from the V1 build** (#18); not exercised in V1.
4. ~~A staff member edits their own `bio_en`...~~ — removed 2026-10-03 (#21); no self-service endpoint exists.
5. ~~The same person, assigned to two stores in one chain, shows two independent stats totals...~~ — **reversed 2026-10-03 (#20)**: the same person at two stores in one chain now shows the **same, chain-wide** total on both profile pages.
6. `title` can only ever be set via the admin endpoint (§6.2) — there is no other endpoint for it to be "read-only" on.
7–14. ~~(self-service merge-patch / staging / review test cases)~~ — **removed 2026-10-03 (#21)**; no self-service writer, no `_pending` columns, no review actions exist to test.
15. A public booking with an explicit customer-chosen `staff_id` (Step-2 pick or `?staff_id=` deep link), later marked `completed` → counts toward that staff member's specified-booking stat (#12/#20); the same booking left at `confirmed` or marked `no_show` does not count.
16. A public booking in "any available" mode, server-resolves to a staff member, later `completed` → does **not** count toward that staff member's specified-booking stat (`staff_specified=false`) even though it completed with them.
17. A staff-manual booking assigning a specific technician → `staff_specified=false` regardless of how deliberately the staff member chose that technician — the column only ever reflects a public-channel customer's own explicit choice.
18. `bio` (English-only, #22) accepts up to 500 characters; there is no `bio_zh` field anywhere in the request or response shape.

## 8. Non-goals

1. Staff accepting bookings individually — every appointment remains store-owned, never staff-owned.
2. ~~A chain-wide aggregate stats view...~~ — **built, 2026-10-03 (#20)**: stats are chain-wide by default now, not a deferred aggregate view; see §5.
3. Free-text language entry.
4. Rich-text bio editor.
5. **Staff self-service profile editing, in any form** (2026-10-03, #21) — removed along with the review workflow; redesigned fresh if/when a staff portal exists.
