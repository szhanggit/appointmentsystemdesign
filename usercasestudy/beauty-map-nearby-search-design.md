# Beauty Map — Nearby Search API

**Status:** the customer-facing "find beauty stores near me" query API. Companion docs: `beauty-map-postgis-schema-design.md` (storage, the shared `service_is_bookable()` function, the category taxonomy), `beauty-map-filtering-design.md` (filter semantics), `beauty-map-ui-design.md` (the 5 pages). Deep-links into `public-booking-end-to-end-design.md` (`/book/{store_id}`).

Baseline: Mapbox is the chosen map provider (account `growaydev`, v1 uses the default public token). Coordinates are populated at store onboarding via Mapbox geocoding (`growayshop-registration-workflow.md` §2.2). This document only reads them.

## 1. Decisions

1. **Two query modes, one PostGIS core.** Map-driven `bbox` mode (viewport) is primary; `radius` mode ("near me" list) is secondary. Both hit the same predicate builder — two endpoints would drift.
2. **Public, no login, IP rate-limited.** Same posture as the public booking flow: discovery must be frictionless. The abuse surface is read-only.
3. **`GEOGRAPHY`, not `GEOMETRY`.** Distances in meters, no projection math, correct across the Toronto area out of the box.
4. ~~Test stores are invisible...~~ — **removed 2026-10-03 (Steven, #6).** `store.stores.is_test` doesn't exist; there is no store-level test concept in V1 (competitor check: none of Fresha/Vagaro/Mindbody/Booker/Square/GlossGenius has one). Every `active`, geolocated store is visible on the map regardless of whether it has test appointments on it — the appointment-level flag (itself removed entirely 2026-10-05, #18 superseded, not merely deferred) was never a map-visibility concern anyway.
5. **Inactive / unlocated stores are invisible.** `status <> 'active'` or `NULL` coordinates → excluded. A store that hasn't finished onboarding doesn't exist on the map.
6. **Result cap, not deep pagination.** Map clients don't paginate; the response is capped (200) and the client clusters. A list-mode client uses `limit`/`offset` within the cap.

## 2. Endpoints

### 2.1 `GET /api/customer/stores/nearby` — bbox mode (primary)

```
GET /api/customer/stores/nearby
  ?bbox=minLng,minLat,maxLng,maxLat   # map viewport, WGS84
  &limit=200                          # default 200, max 200
  &<filter params>                    # see beauty-map-filtering-design.md
```

- `bbox` required. Antimeridian crossing is not handled in v1 (Toronto-only market).
- Invalid bbox (min ≥ max, out of range) → `400 INVALID_BBOX`.

### 2.2 `GET /api/customer/stores/nearby` — radius mode

```
GET /api/customer/stores/nearby
  ?lat=43.65&lng=-79.38&radius_km=5   # center + radius, default 5, max 50
  &limit=50&offset=0
  &<filter params>
```

- `lat`/`lng`/`radius_km` required as a group; mixing with `bbox` → `400`.
- Sort is always distance-ascending in radius mode. In bbox mode sort is also distance-ascending from the viewport center (cheap, stable); the client re-sorts visually anyway.

### 2.3 Shared response

```json
{
  "stores": [
    {
      "id": "uuid",
      "name": "Selah Head Spa",
      "latitude": 43.8563, "longitude": -79.3378,
      "distance_m": 850,
      "avg_rating": null, "rating_count": 0,
      "price_from_cents": 6800,
      "categories": ["head-spa", "facial"],
      "open_now": true,
      "address_display": "8120 Bayview Ave, Richmond Hill"
    }
  ]
}
```

- `distance_m`: `ST_Distance` in meters, rounded. In bbox mode measured from viewport center.
- `avg_rating`/`rating_count`: always present in the response shape, but carry no real data in v1 (`beauty-map-postgis-schema-design.md` §1.3) — every store reports `null`/`0` until V1.1. The v1 UI never renders them (`beauty-map-ui-design.md` §1 decision 5 / §6).
- `address_display`: derived at read time, never stored — `COALESCE(formatted_address, address_line1 || ', ' || city)`, preferring Mapbox's own display string when geocoding succeeded, falling back to a simple concat for a manually-typed address with no coordinates.
- `categories`: **taxonomy slugs only**, and only for categories that currently have ≥1 bookable service (`store.service_is_bookable()`, `beauty-map-postgis-schema-design.md` §4) — never the store's own free-text category names. A category with no taxonomy mapping, or whose only services aren't currently bookable, is simply absent from this array; the store's detail page (`beauty-map-ui-design.md` §5) still shows its own categories and names normally, unaffected by this filter-only exclusion.
- `open_now`: computed per request from `business_hours` in the store's timezone (best effort; a store with no hours set reports `open_now: false`, never `true`).
- No staff or per-service pricing detail here — the detail page fetches that (`beauty-map-ui-design.md` page 4).

## 3. PostGIS core

```sql
-- bbox mode
SELECT s.id, s.name, s.latitude, s.longitude,
       ST_Distance(s.geo, ST_MakePoint(:c_lng, :c_lat)::geography)::int AS distance_m,
       s.avg_rating, s.rating_count, s.price_from_cents,
       COALESCE(s.formatted_address, s.address_line1 || ', ' || s.city) AS address_display
FROM store.stores s
WHERE s.status = 'active'
  AND s.geo IS NOT NULL
  AND s.geo && ST_MakeEnvelope(:min_lng, :min_lat, :max_lng, :max_lat, 4326)::geography
  AND <filter predicates>            -- beauty-map-filtering-design.md §3
ORDER BY s.geo <-> ST_MakePoint(:c_lng, :c_lat)::geography
LIMIT 200;

-- radius mode: replace the envelope line with
  AND ST_DWithin(s.geo, ST_MakePoint(:lng, :lat)::geography, :radius_m)
```

- `&&` (bounding-box overlap) uses the GIST index first; `<->` gives index-assisted nearest-neighbor ordering.
- The envelope is cast to geography so `&&` works in meters-consistent space.
- `categories` is fetched by a second, small query per result page (taxonomy slugs with ≥1 bookable service, per-store), not joined into the core query above — keeps the hot path's index usage simple.

## 4. Rate limiting & caching

- IP-based rate limit (same tier as the public slots endpoint).
- No server-side result cache in v1 — the query is a single indexed scan, milliseconds at v1 data volumes. Revisit if a metro ever exceeds ~10k stores.

## 5. Test cases

1. Viewport over downtown → only `active`, geolocated stores returned.
2. `radius_km=5` around a point → results sorted by `distance_m` ascending; a store 5.1 km away is excluded.
3. `bbox` with min ≥ max → `400 INVALID_BBOX`.
4. ~~A store with `is_test = true`...~~ — removed 2026-10-03; no store-level test flag exists (#6).
5. A store with `NULL` geo → not returned, no error.
6. 250 stores in viewport → 200 returned (cap), no pagination error.
7. A store whose only service in "Facial" has no bookable staff → "facial" absent from its `categories` array, even though the store itself still has a category named "Facial" in its own back-office.
8. A store with a manually-typed, un-geocoded address still returns `address_display` from the line1/city fallback.

## 6. Deferred

1. Keyword/name search ("head spa near me" text query) — v1 is map-browse only.
2. Saved favorites / recently viewed.
3. Server-side clustering (v1 clusters client-side).
4. Antimeridian-safe bbox.
