# Beauty Map — PostGIS Schema

**Status:** the storage increment that powers `beauty-map-nearby-search-design.md`. Builds on `store-onboarding-v1-design.md` §4 (`store.stores` address columns, `store.services`/`service_categories`) and §7 (service catalog) — this document only **adds** columns and functions, it never redefines existing ones.

## 1. Decisions

1. **`GEOGRAPHY(Point, 4326)`, not separate lat/lng math.** `latitude`/`longitude` decimals stay as the source of truth (already populated by onboarding's Mapbox geocoding, `growayshop-registration-workflow.md` §2.2); `geo` is the derived, queryable form.
2. **`geo` is maintained by a trigger, not application code.** Every writer path (onboarding, store settings edit, manual pin adjustment) would otherwise need to remember to rebuild it; a trigger can't be forgotten.
3. **Rating is cached columns, not a reviews table, in v1 — and ships empty.** `avg_rating`/`rating_count` exist on `store.stores` so V1.1's review-writing feature needs no migration, but v1 has no writer path for them at all. Importing Google ratings is a ToS risk; hand-entering them is fabricating data — both are worse than an honest "no ratings yet." The columns exist now purely to avoid a later migration; populating them is out of scope here.
4. **`price_from_cents` is a cached column, recomputed on bookability-affecting writes (§4).** Filter queries run on every map pan — joining to services live would be the wrong trade at that frequency. A single recompute function (§4) keeps every write path consistent.
5. **GIST index on `geo`.** The `&&` / `<->` / `ST_DWithin` operators the nearby-search query uses all resolve through it.
6. ~~A store-level `is_test` column, separate from `appointments.is_test`~~ — **dropped entirely, 2026-10-03 (Steven, #6).** Competitor check (Fresha, Vagaro, Mindbody, Booker, Square Appointments, GlossGenius): none has a test-store concept — most train on live accounts or free trials; Square's sandbox is developer-only. ~~The appointment-level flag already covers training~~ — that flag is itself gone now too (removed 2026-10-05, #18 superseded); at the time this decision was made it was still the retained design, which was reason enough on its own. The store-level flag's marginal value (convenience + map invisibility) didn't justify its abuse surface (a real store flipping this to hide from the public map indefinitely) regardless. This supersedes the earlier "back-office-only test stores" and "Groway-admin-only flag, one-per-chain" mitigation ideas — both are moot once the flag itself is gone.
7. **Service bookability gets one shared SQL function**, not three independent copies of the same `WHERE` logic. `store-onboarding-v1-design.md` §7.6 already defines "bookable" as derived (never a stored flag): `deleted_at IS NULL AND status='active' AND EXISTS(≥1 active staff assignment)`. `price_from_cents` (this document), the category filter (`beauty-map-filtering-design.md`), and the nearby-search response's `categories` array (`beauty-map-nearby-search-design.md`) all now call the same function — a service that's actually unbookable can't show up as "available" in one place and not another.
8. **Category filtering needs a shared taxonomy, which store-scoped categories can't provide.** `service_categories` is per-store free text (§7 of the onboarding doc) — two stores naming their category "Head Spa" have no common key, and free text (bilingual, typo-prone) can't be a filter key. A small platform-wide taxonomy (11 seed categories, §3) is a narrow, deliberate exception to "shared catalog is v2" (`store-onboarding-v1-design.md` §9.5) — store-owned categories, names, and prices are untouched; the taxonomy exists only for cross-store discovery.

## 2. Schema increment

```sql
-- PostGIS (once per database)
CREATE EXTENSION IF NOT EXISTS postgis;

-- 2a. Queryable geography, derived from the onboarding-populated lat/lng
ALTER TABLE store.stores
  ADD COLUMN geo GEOGRAPHY(Point, 4326);

CREATE INDEX idx_stores_geo ON store.stores USING GIST (geo);

CREATE OR REPLACE FUNCTION store.stores_geo_sync()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.latitude IS NOT NULL AND NEW.longitude IS NOT NULL THEN
    NEW.geo := ST_MakePoint(NEW.longitude, NEW.latitude)::geography;
  ELSE
    NEW.geo := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_stores_geo_sync
  BEFORE INSERT OR UPDATE OF latitude, longitude ON store.stores
  FOR EACH ROW EXECUTE FUNCTION store.stores_geo_sync();

-- Backfill stores created before this column existed
UPDATE store.stores
SET geo = ST_MakePoint(longitude, latitude)::geography
WHERE latitude IS NOT NULL AND longitude IS NOT NULL AND geo IS NULL;

-- 2b. Rating cache (ships empty in v1; see decision 3)
ALTER TABLE store.stores
  ADD COLUMN avg_rating    NUMERIC(2,1),
  ADD COLUMN rating_count  INT NOT NULL DEFAULT 0;
-- avg_rating NULL = "no ratings yet" (distinct from 0.0); nothing writes these columns in v1.

-- 2c. Cheapest-bookable-service cache for the price filter
ALTER TABLE store.stores
  ADD COLUMN price_from_cents INT;
-- NULL when the store has no currently-bookable service (see §4's definition).

-- 2d. ~~Store-level test flag~~ — DROPPED 2026-10-03 (decision 6, #6). This
-- column does not exist in V1. If it was ever added to a running database,
-- `DROP COLUMN is_test` is the migration; nothing else in this document reads it.
```

- Categories for filtering come from the taxonomy introduced in §3, mapped from the existing per-store catalog (§7 of the onboarding doc) — no change to how a store's own categories/names/prices work.

## 3. Category taxonomy

```sql
CREATE SCHEMA IF NOT EXISTS platform;

-- name_zh DROPPED 2026-10-03 (#22, V1 is English-only — no i18n framework,
-- no translated content anywhere in the product). BCP-47 codes elsewhere
-- (platform.spoken_languages) stay, since those are data, not display
-- strings — this table only ever had a display string, so it's gone outright.
CREATE TABLE platform.category_taxonomy (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       VARCHAR(50) NOT NULL UNIQUE,
  name_en    VARCHAR(64) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0
);

INSERT INTO platform.category_taxonomy (slug, name_en, sort_order) VALUES
  ('head-spa',       'Head Spa',           10),
  ('facial',         'Facial',             20),
  ('massage',        'Massage',            30),
  ('nails',          'Nails',              40),
  ('hair',           'Hair',               50),
  ('lashes-brows',   'Lashes & Brows',     60),
  ('waxing',         'Waxing',             70),
  ('skincare',       'Skincare',           80),
  ('barbering',      'Barbering',          90),
  ('wellness',       'Wellness',          100),
  ('med-aesthetics', 'Medical Aesthetics', 110);  -- the partner's med-aesthetics clinic is a confirmed plan (2026-09-29), not a hypothetical — seeded now so it isn't a post-launch taxonomy addition

ALTER TABLE store.service_categories
  ADD COLUMN taxonomy_id UUID REFERENCES platform.category_taxonomy(id);
-- Nullable and optional: a store's category can exist with no taxonomy mapping.
-- An unmapped category still works normally everywhere in that store's own UI —
-- it simply doesn't participate in cross-store map discovery (beauty-map-filtering-design.md §2,
-- beauty-map-ui-design.md §6).
```

- Store staff pick a taxonomy entry from a dropdown when creating or editing a category (optional field) — never free-typed, never auto-guessed from the category name.
- Growing the taxonomy (adding a new seed category later) is a Groway-admin action on `platform.category_taxonomy`, not something a store can do — it's shared platform state.
- Pre-existing categories (created before this table existed) default to `taxonomy_id = NULL` — the migration/nudge behavior for those is `beauty-map-ui-design.md` §6.

## 4. Shared bookability function

```sql
CREATE OR REPLACE FUNCTION store.service_is_bookable(p_service_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
    FROM store.services sv
    JOIN store.staff_services ss ON ss.service_id = sv.id AND ss.store_id = sv.store_id
    WHERE sv.id = p_service_id
      AND sv.deleted_at IS NULL
      AND sv.status = 'active'
      AND EXISTS (  -- 2026-10-03, Batch 4: no assignment, no status - "works here" is
                    -- a live schedule entry at this store, full stop (staff_services is
                    -- already (staff_id, store_id) keyed, Batch 4 Decision 1)
        SELECT 1 FROM store.staff_schedules sch
        WHERE sch.staff_id = ss.staff_id AND sch.store_id = ss.store_id AND sch.deleted_at IS NULL
      )
  );
$$ LANGUAGE sql STABLE;
```

This is the **one** definition of "bookable" for map purposes — identical to `store-onboarding-v1-design.md` §7.6's rule. Three call sites use it, and must keep using it rather than each re-deriving their own approximation:
1. `price_from_cents` recompute (below).
2. The category filter's `EXISTS` subquery (`beauty-map-filtering-design.md` §3).
3. The nearby-search response's `categories` array (`beauty-map-nearby-search-design.md` §2.3).

## 5. `price_from_cents` recompute

```sql
CREATE OR REPLACE FUNCTION store.recompute_store_price_from(p_store_id UUID)
RETURNS VOID AS $$
  UPDATE store.stores
  SET price_from_cents = (
    SELECT MIN(effective_price) FROM (
      SELECT CASE
               WHEN sv.price_type = 'from' THEN (
                 SELECT MIN(so.price_cents) FROM store.service_options so
                 WHERE so.service_id = sv.id AND so.deleted_at IS NULL
               )
               ELSE sv.price_cents
             END AS effective_price
      FROM store.services sv
      WHERE sv.store_id = p_store_id
        AND store.service_is_bookable(sv.id)
    ) priced
    WHERE effective_price IS NOT NULL
  )
  WHERE id = p_store_id;
$$ LANGUAGE sql;
```

Definition: the lowest price among services that currently pass `service_is_bookable()` — not just "not deleted," the full test. Called, in the same transaction, from every write path that can change the answer:

1. **Service catalog changes** — create/update/delete/restore a service or option, or change `price_type`/`price_cents` (`store-onboarding-v1-design.md` §7.2/§7.3).
2. **Staff ↔ service assignment changes** — the full-replace `PUT` endpoints (`store-onboarding-v1-design.md` §7.5).
3. **Timetable entry add/remove** — a `staff_schedules` row for this store is inserted, soft-deleted, or un-deleted (2026-10-03, Batch 4 — supersedes the old "staff status changes" framing entirely; there is no status anywhere, only the timetable, `staff-schedule-entry-workflow.md` §0).

**Not** triggered by `staff_schedules`/`staff_time_offs` changes — `price_from_cents` answers "what does this store sell," not "is someone free right now." A fully-booked-out store still has a `price_from`.

## 6. Data invariants

1. `geo IS NOT NULL` ⟺ `latitude`/`longitude` both set (trigger guarantees it).
2. `rating_count = 0` ⟹ `avg_rating IS NULL`.
3. `price_from_cents` is never negative; `NULL` only when no service currently passes `service_is_bookable()`.
4. `service_categories.taxonomy_id IS NULL` is a valid, permanent state — not every store category needs a platform mapping.

## 7. Test cases

1. Insert a store with lat/lng → `geo` populated, `ST_DWithin` finds it.
2. Update lat/lng via pin-adjust → `geo` follows; the old position no longer matches.
3. Set lat/lng to `NULL` → `geo` becomes `NULL`, the store silently drops off the map query.
4. `EXPLAIN` on the nearby query shows a GIST index scan, not a sequential scan.
5. Remove a service's only assigned staff member's live entries at this store → `service_is_bookable()` flips to `false` → the next write on that path recomputes `price_from_cents` and it excludes that service.
6. ~~Mark a store `is_test=true`...~~ — removed 2026-10-03; `stores.is_test` doesn't exist (decision 6, #6).
7. A category created with no `taxonomy_id` → store's own UI shows it normally; map category filter never matches it.

## 8. Deferred

1. Full `reviews` table + review-writing UI, and actually populating `avg_rating`/`rating_count` (V1.1).
2. `GEOMETRY` + local projection, if a metro ever needs sub-meter survey precision (not a beauty-booking concern).
3. Store "service area" polygons (mobile services) — v1 is point-only.
4. Groway-admin UI for managing `platform.category_taxonomy` itself (v1 seeds it via migration; growing the list is a manual SQL change until that UI exists).
