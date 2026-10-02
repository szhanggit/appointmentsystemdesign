# Store Profile Enrichment — Design

**Status:** V1.1. Extends the store detail page (`beauty-map-ui-design.md` page 4) and `store-onboarding-v1-design.md` §4 with About text, store/staff photos, and a dual-source (display-only) ratings section. Companion: `staff-profile-design.md` (the public staff page, which shares this document's photo table).

## 1. Decisions

1. **About is bilingual plain text, no rich-text editor.** `store.stores` gains `about_en`/`about_zh`; no XSS filtering or layout engine is built for v1.1 — plain text with line breaks is the entire feature. `store_admin` writes and saves it directly, no Groway moderation (abuse risk here is far lower than photos; a complaint-driven takedown is enough). Empty → the About section simply doesn't render, no "no description yet" placeholder.
2. **One photo table covers three use cases, with a moderation-status field built in from the start.** Store banner, store gallery, and per-staff portfolio all live in `store.store_photos`, distinguished by `kind` and a nullable `staff_id`. The `status` enum exists now specifically so that a future, less manual review process needs no migration.
3. **Photo moderation is manual, Groway-admin only, with no SLA.** Pilot scale doesn't need AI-assisted review or an appeals flow yet; the schema just doesn't block adding either later.
4. **Reviews reserve `staff_id` in the schema now; review-writing itself is explicitly out of scope here.** Whenever a review-writing feature actually gets built, it needs `staff_id` from day one (the Fresha "with {staff}" pattern) — adding it after reviews already exist would mean backfilling. This document only reserves the column shape.
5. **Ratings display is dual-source, modeled on COSReady**: an on-platform rating (reviews, currently always empty since review-writing isn't built) and a separately-labeled Google Places aggregate, shown side by side, never merged into one number, never written back to Google. Chosen specifically to avoid a cold-start store page with a blank or "0 reviews" rating.

## 2. Schema

### 2.1 About (ALTER on `store-onboarding-v1-design.md`'s `store.stores`)

```sql
ALTER TABLE store.stores
  ADD COLUMN about_en TEXT CHECK (char_length(about_en) <= 2000),
  ADD COLUMN about_zh TEXT CHECK (char_length(about_zh) <= 2000);
```

- Plain text, line breaks preserved on render, never HTML-interpreted.
- `NULL`/empty on either language → that language's About section is omitted from the detail page, not shown with placeholder copy.

### 2.2 Photos

```sql
CREATE TABLE store.store_photos (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id         UUID NOT NULL REFERENCES store.stores(id),
    staff_id         UUID REFERENCES store.staff(id),  -- NULL = store-level; non-NULL = that staff member's portfolio
    s3_key           TEXT NOT NULL,
    sort_order       INT NOT NULL DEFAULT 0,
    is_banner        BOOLEAN NOT NULL DEFAULT false,    -- top banner image; ≤1 per store, app-enforced (§3)
    kind             VARCHAR(20) NOT NULL DEFAULT 'gallery' CHECK (kind IN ('banner','gallery','portfolio')),
    status           VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
    rejection_reason TEXT,
    uploaded_by      UUID REFERENCES store.store_users(id),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_store_photos_store_approved ON store.store_photos(store_id) WHERE status = 'approved';
CREATE INDEX idx_store_photos_staff_approved ON store.store_photos(staff_id) WHERE staff_id IS NOT NULL AND status = 'approved';
```

- The public client only ever reads `status='approved'` rows.
- **When `staff_id` is set, it must belong to a staff member with an active `staff_store_assignments` row at `store_id`** — an application-level invariant, the same category as the same-store rule that `store.service_is_bookable()` enforces for services (`beauty-map-postgis-schema-design.md` §4); a plain FK can't express "and also assigned at this specific store." Checked at write time; an upload where the staff member has no assignment at this store is rejected with `400 STAFF_NOT_AT_STORE`.
- Storage: S3 + CloudFront (already in the architecture); upload goes straight to S3 via a presigned URL, never through the app server.
- Limits: `jpg`/`png`/`webp`, ≤5MB; ≤20 photos in a store's gallery, ≤10 in any one staff portfolio; banner recommended 16:9 (hinted in the UI, not hard-enforced).

### 2.3 Reviews — schema reserved, writing not designed here

```sql
-- Reserved shape for whenever review-writing actually ships (separate, future scope):
CREATE TABLE store.reviews (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id   UUID NOT NULL REFERENCES store.stores(id),
    staff_id   UUID REFERENCES store.staff(id),  -- NULL = store-level review; non-NULL = "with {staff}" (Fresha pattern)
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    -- rating, body, customer_id, moderation state, etc. are for that future document to define
);
```

`staff_id` has to exist from the first migration — adding it after reviews are already live would mean backfilling every existing row, which reserving it now avoids entirely. Nothing else about review-writing — the submission endpoint, moderation flow, or customer-facing "write a review" UI — is in this document's scope.

## 3. Photo management (store side)

- Upload: drag/drop or file picker → direct-to-S3 via presigned URL → row created at `status='pending'`, invisible to customers.
- Thumbnail grid with drag-to-reorder (`sort_order`); a "Set as banner" button (`is_banner`); delete requires a confirmation dialog.
- Exactly one `is_banner=true` row per store is guaranteed at the **application** layer, not a DB constraint — a DB uniqueness constraint would fight with reordering during the moment a new banner is being swapped in. The "Set as banner" action always unsets any prior banner in the same write.
- Status badges: pending / approved / rejected (rejection shows the Groway-entered reason).
- Per-staff portfolio upload lives on the staff-profile editor (`staff-profile-design.md` §6), writing into this same table with `staff_id` set — one table, two upload surfaces.

## 4. Groway moderation queue

- Back office: a "Pending photos" list — thumbnail, store/staff name, upload time, [Approve] / [Reject + reason]. Batch-approve supported.
- No AI-assisted moderation and no appeals flow in v1.1.
- A rejection notifies the store through whichever notification channel is already live (in-app once it exists, email until then) — no new channel is built for this.
- No moderation SLA is committed; pilot-scale volume keeps the manual queue small.

## 5. Detail page changes (extends `beauty-map-ui-design.md` page 4)

- About section renders only when that language's text is non-empty.
- Banner: one large image at the top; approved gallery photos scroll horizontally beneath it. No approved photos yet → a neutral default banner, never a broken image.
- Ratings section (dual-source): the on-platform rating (currently always empty, since review-writing isn't built, §2.3) is shown separately from a Google-sourced aggregate, labeled "via Google," never merged into a single blended number. **Depends on confirming Google Places API quota and ToS compliance before implementation** — that confirmation is an open prerequisite, not resolved by this document.
- Each staff member listed on the detail page links out to their public profile (`staff-profile-design.md`).

## 6. Validation rules

| Field | Rule |
|---|---|
| `about_en` / `about_zh` | ≤2000 characters, plain text |
| Photo file | `jpg`/`png`/`webp`, ≤5MB |
| Store gallery | ≤20 photos (pending + approved) |
| Staff portfolio | ≤10 photos per staff member (pending + approved) |

## 7. Test cases

1. A `pending` photo is invisible on the public detail page; approving it makes it appear on the next load.
2. Two rows both marked `is_banner=true` (a data anomaly) → the application only honors the one with the lowest `sort_order`; the "Set as banner" UI action is designed to prevent this from happening in the first place.
3. Uploading a photo with `staff_id` set to someone with no assignment at this store → `400 STAFF_NOT_AT_STORE`.
4. Empty `about_en` → the English detail page renders no About section at all, not a placeholder.
5. A store with zero approved photos → the detail page shows the neutral default banner.

## 8. Non-goals (v1.1)

1. Rich-text About editor.
2. AI photo moderation; an appeals flow.
3. Video portfolio.
4. Review-writing itself (submission UI, moderation, scoring) — only the schema shape is reserved (§2.3).
5. Writing back to Google reviews.
