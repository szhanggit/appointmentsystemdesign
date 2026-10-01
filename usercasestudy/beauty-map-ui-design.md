# Beauty Map — Map UI

**Status:** the customer/store pages for map discovery. Data contracts come from `beauty-map-nearby-search-design.md` §2.3 and `beauty-map-filtering-design.md` §2. Booking itself is `public-booking-end-to-end-design.md` (`/book/{store_id}`) — the map hands off, it doesn't reimplement.

Baseline: mobile-first, Mapbox GL JS, bilingual en/zh (same i18n framework as the booking flow). One shared Groway map style in v1.

## 1. Decisions

1. **Map-first, list as secondary.** The v1 differentiator is the map; the list is a radius-mode rendering of the same API, not a separate product.
2. **Marker tap → preview card → detail page.** Two-step drill-down: the map stays uncluttered, the card answers "is this worth a tap," the page answers "book or not."
3. **Detail page reuses booking-flow components.** Service list, price display ("from $X" = live `MIN(options)`), staff picker — same components as `/book/{store_id}` Step 1–2, not copies.
4. **Store-side coordinate edit = autocomplete + draggable pin.** Address entry stays the Mapbox Search Box autocomplete already designed (`growayshop-registration-workflow.md` §2.2); this page only adds the pin fine-tune + save. One page, not two flows.
5. **No rating UI anywhere in v1** — not a badge, not a filter, not a "no ratings yet" placeholder. `avg_rating`/`rating_count` exist in the schema and the API response (`beauty-map-postgis-schema-design.md` §1.3, `beauty-map-nearby-search-design.md` §2.3) purely so V1.1 needs no migration; until real rating data exists, showing a rating UI element would either be permanently empty (confusing) or require extra "no ratings yet" copy everywhere it could appear. Simpler to omit it entirely and add it back in V1.1.
6. **No store photos in v1 map markers.** Custom marker images are a content-moderation problem; v1 markers are price badges only (no rating-toggle mode, per decision 5). A photo carousel lives on the detail page only if the store uploaded photos (V1.1 scope for uploads).

## 2. Page 1 — Map home (customer)

- Full-screen Mapbox map, centered on customer location (browser geolocation, with graceful fallback to a default downtown-Toronto center when denied).
- Markers: clustered at low zoom (Mapbox GL JS native clustering on the GeoJSON source), individual pins at high zoom. Pin badge shows `price_from` only ("$68+") — no rating-toggle mode in v1 (decision 5).
- "Locate me" button re-centers. Map move (debounced 300 ms) re-queries bbox mode.
- Filter button with active-count badge → Page 2 drawer.
- Tap marker → Page 3 preview card (bottom sheet, map still visible behind).

## 3. Page 2 — Filter drawer (customer)

- Bottom sheet with the four v1 UI dimensions (`beauty-map-filtering-design.md` §4): category chips (sourced from `platform.category_taxonomy`, not store-specific names), distance (radius-mode only — a slider 1–50 km; hidden in bbox mode where the viewport *is* the distance), max price (slider), open-now toggle.
- No rating control (decision 5; the API parameter still exists for V1.1).
- Apply-on-change (debounced), "Clear all" resets. Empty result → inline hint ("try widening the map or clearing filters"), never a dead blank map.

## 4. Page 3 — Store preview card (customer)

- Bottom sheet over the map: name, distance, `price_from`, open-now badge / "Opens 10 AM," `address_display`, category chips (taxonomy slugs the store currently has a bookable service for).
- No rating line (decision 5).
- Button: [View details] → Page 4. Swipe down dismisses.
- No booking action here — booking starts on the detail page, one consistent entry point.

## 5. Page 4 — Store detail page (customer)

- Header: name, distance, address (tap → external maps app), phone (tap → call). No rating (decision 5).
- Hours summary (today's hours + "see all" expander).
- Services grouped by the store's **own** categories (not taxonomy slugs — taxonomy is a map-discovery concept only, §6) with live "from $X" pricing (shared component with booking Step 1).
- Sticky bottom CTA: [Book] → `/book/{store_id}` (the public booking flow takes over).
- Unknown / inactive `store_id` → generic 404 ("Online booking isn't available for this store"), same rule as the booking flow.

## 6. Store-side: category taxonomy mapping

Lives on the existing category management screen in the back office (`store-onboarding-v1-design.md` §7.1) — not a new page.

- Creating or editing a category shows an optional "Map to a map-search category" dropdown, listing `platform.category_taxonomy`'s ~10 entries. Never free-typed, never auto-guessed.
- **Migration nudge for existing stores**: the first time a store's category list loads after this taxonomy ships, any category with `taxonomy_id IS NULL` is flagged inline — "Unmapped — won't be found by map category search" — with a one-click dropdown right there to map it. Nothing is auto-mapped and nothing is forced; leaving it unmapped is a valid, permanent choice (the category keeps working normally everywhere else in that store's own UI).
- This nudge matters for the pilot store specifically: it's an existing store, so without the nudge its categories would silently never appear in map search with no indication why — a bad look for a launch demo.

## 7. Store-side: address/coordinate settings

- Store settings section. Address field = the Mapbox Search Box autocomplete from `growayshop-registration-workflow.md` §2.2 (unchanged).
- Map with a draggable pin initialized at the geocoded position; dragging updates lat/lng; [Save] writes through the existing store-update endpoint → the `trg_stores_geo_sync` trigger rebuilds `geo` (`beauty-map-postgis-schema-design.md` §2).
- Save confirms with the resolved address + coordinates shown ("Pin set to 8120 Bayview Ave — 43.8563, -79.3378").
- The store-level `is_test` toggle (`beauty-map-postgis-schema-design.md` §2d) lives on the general store settings page, not here — it's a `store_admin`-facing switch on the existing store-update endpoint, not a new page or a map-specific concept.

## 8. Test cases

1. A store with no bookable service in any taxonomy-mapped category → no chips shown on its preview card, but its detail page shows its own categories/services normally.
2. Opening a pre-existing store's category list for the first time post-launch → unmapped categories show the nudge banner; mapping one via the dropdown clears it for that category.
3. No rating element appears anywhere in the customer-facing flow (pages 1, 3, 4) or the filter drawer (page 2).
4. Toggling a store to `is_test=true` in settings → it disappears from the public map on the next query, with no change to its normal booking behavior.
5. Dragging the pin on page 7 and saving → the map home page (page 1) shows the store at the new position on the next load.

## 9. Deferred (V1.1)

1. Rating UI (badge, filter, detail-page summary) once `avg_rating`/`rating_count` have real data.
2. Review-writing UI.
3. Keyword/name search box.
4. Favorites / recently viewed.
5. Store photo uploads + moderation.
6. Per-store map marker branding.
7. "Navigate" in-app turn-by-turn (v1 hands off to the external maps app).
8. Groway-admin UI for editing `platform.category_taxonomy` (v1 seeds it via migration).
