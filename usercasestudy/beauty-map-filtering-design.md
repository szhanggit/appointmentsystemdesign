# Beauty Map — Filtering

**Status:** filter dimensions for the map and list views. Consumes `beauty-map-nearby-search-design.md` §2 (endpoint) and `beauty-map-postgis-schema-design.md` §4/§5 (the shared `service_is_bookable()` function and cached columns). All filters compose with `AND` against the geo predicate.

## 1. Decisions

1. **Five dimensions in the API; v1's UI exposes four.** Category, distance, price, and open-now are live in v1. `min_rating` stays a documented, accepted API parameter — it's just inert, since no store has rating data yet (`beauty-map-postgis-schema-design.md` §1.3) — so V1.1 only has to ship the UI picker, not an API change. The v1 UI never renders a rating control (`beauty-map-ui-design.md` §6).
2. **Price filter is one-sided: `price_max_cents`.** Semantics: "cheapest bookable service ≤ X." A two-sided range over stores with $30–$200 menus creates range-overlap ambiguity nobody needs in v1; the real job is "find something affordable nearby."
3. **Distance is the geo mode itself, not a separate filter.** Bbox mode = viewport; radius mode = `radius_km`. No second distance param stacked on top.
4. **Filters never widen the geo result.** A filter can only remove stores, never add ones outside the viewport/radius — the map never lies about what's shown.
5. **Client-side clustering.** Mapbox GL JS clusters the GeoJSON source natively. No backend clustering work in v1; the 200-point cap keeps it smooth.
6. **Category matching uses the same bookability test as everything else** (`store.service_is_bookable()`) — not just "category has a non-deleted service." A map chip that matches a service nobody can actually book is the same kind of lie the price cache was built to avoid (`beauty-map-postgis-schema-design.md` §1.7); there is exactly one definition of "this store offers X," used everywhere.

## 2. Filter parameters

| Param | Type | In v1 UI? | Semantics |
|---|---|---|---|
| `category` | taxonomy slug | ✅ | Store has ≥1 service, mapped to this taxonomy entry, that currently passes `service_is_bookable()` |
| `min_rating` | number | — (API only) | `avg_rating >= min_rating`; always empty-result in v1 since no store has rating data (kept for V1.1 forward-compatibility, §1) |
| `price_max_cents` | int | ✅ | `price_from_cents <= price_max_cents` |
| `open_now` | bool | ✅ | `true` → only stores currently open (computed from `business_hours` in store tz) |

- All optional, AND-combined. Unknown category slug → `400 INVALID_CATEGORY`.
- `min_rating=0` is equivalent to unset (no filtering); any `min_rating > 0` value is accepted by the API and will correctly return zero matches until V1.1 populates rating data — this is expected, not a bug, and is exactly why the v1 UI doesn't expose the control.

## 3. SQL composition

```sql
-- appended to the WHERE clause of beauty-map-nearby-search-design.md §3
AND (:category    IS NULL OR EXISTS (
      SELECT 1 FROM store.services sv
      JOIN store.service_categories sc ON sc.id = sv.category_id
      JOIN platform.category_taxonomy ct ON ct.id = sc.taxonomy_id
      WHERE sv.store_id = s.id
        AND ct.slug = :category
        AND store.service_is_bookable(sv.id)))
AND (:min_rating  IS NULL OR (s.avg_rating IS NOT NULL AND s.avg_rating >= :min_rating))
AND (:price_max   IS NULL OR (s.price_from_cents IS NOT NULL AND s.price_from_cents <= :price_max))
AND (:open_now    IS NOT TRUE OR store.is_open_now(s.id))
```

- `store.is_open_now(store_id)`: helper reading `business_hours` in the store's timezone; returns `false` when hours are unset. Best effort, v1.
- The category match now joins through `service_categories.taxonomy_id` (`beauty-map-postgis-schema-design.md` §3) and calls `store.service_is_bookable(sv.id)` instead of checking `sv.status = 'active'` alone — a service whose only staff member is deactivated no longer satisfies the filter, matching `price_from_cents`'s own definition exactly.
- The category subquery is the only join in the hot path; at v1 volumes it's fine. If it ever shows in profiles, denormalize taxonomy slugs onto the store row (same pattern as `price_from_cents`).

## 4. UI contract (see `beauty-map-ui-design.md` page 2)

- The filter drawer shows four dimensions in v1 (category, distance, price, open-now) — no rating control.
- Changing any of them re-issues the nearby request with the current viewport (debounced 300 ms on map move).
- Active filter count badge on the drawer button; one-tap "clear all."
- Empty result → "No stores match — try widening the map or clearing filters" (never a blank map with no explanation).

## 5. Test cases

1. `category=head-spa` → only stores with a taxonomy-mapped, currently-bookable head-spa service.
2. A store's "Head Spa" category is mapped to the `head-spa` taxonomy slug, but its only assigned staff member is deactivated → `category=head-spa` excludes it (matches `price_from_cents` test case 5 in the schema doc).
3. `price_max_cents=10000` → a store with cheapest bookable service $68 is included; $120 is excluded.
4. `open_now=true` at 3 AM → only 24h stores (or none), never a closed store.
5. `min_rating=4.5` sent directly to the API (bypassing the v1 UI, which doesn't expose it) → `200` with an empty or near-empty result set, not an error — the parameter is valid, just unproductive until V1.1.
6. All filters combined → strictly fewer results than any subset.
7. Unknown `category=foo` → `400 INVALID_CATEGORY`.

## 6. Deferred

1. Surfacing `min_rating` in the UI (V1.1, once rating data exists — no API change needed).
2. Two-sided price range / price bands ($/$$/$$$).
3. "Accepts walk-ins," "has parking," amenity flags.
4. Sort by rating / price (v1 sorts by distance only).
5. Saved filter presets per customer.
