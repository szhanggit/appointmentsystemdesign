# Public Booking End-to-End — Design

**Status:** the complete self-serve customer booking flow — from opening the booking page to the confirmation screen. Chains together `availability-slot-engine.md` (query times), `create-appointment-transaction-design.md` (create), and `customer-booking-confirmation-reminders-design.md` (notify). This document defines step order, which endpoint each step calls, and how the UI reacts to failure — it does not introduce new business rules.

Baseline: step order is service (now a 1–5 item basket) → staff → time → contact info → confirm. The public API requires no login and is rate-limited by IP + `store_id`. A `from` service's displayed price is `MIN(options)`, computed live.

## 1. Decisions

1. **Multi-service basket booking is promoted to V1, sequential-only, Fresha-style.** A customer can add 2–5 services to one basket; they're scheduled in the **merchant's** set order (`services.sequence_order`, `store-onboarding-v1-design.md` §7), never the order the customer happened to add them in. One technician handles the whole basket — Step 2's staff list narrows to the intersection of everyone qualified for every selected service (`availability-slot-engine.md` §1/§4). Parallel/simultaneous multi-staff bookings (e.g. two technicians working on the same customer at once) remain staff-manual, in-store request only (`V1Backlog.md`) — this flow never offers that.
2. **The confirmation screen offers an `.ics` download.** Trivial to implement (client-side string), good no-show prevention.
3. **Double-submit protection**: the submit button disables on click, plus an `Idempotency-Key`. Mobile users on weak connections tap repeatedly.
4. **`409 SLOT_TAKEN` never shows an error page** — the client silently re-queries that day's slots and highlights what's still open. Being beaten to a slot is normal, not exceptional.
5. **`409 CAPACITY_FULL` gets an explicit message, not a silent refresh** — unlike `SLOT_TAKEN`, a full store is store-wide state, and at peak times neighboring slots are often full too; silently refreshing would make the customer repeatedly hit the same wall with no explanation.
6. **One flow, three entry URLs.** The map/profile pages (`beauty-map-ui-design.md`, `staff-profile-design.md`) all deep-link into this same flow with an optional preselection — a store-detail page, a staff profile's "Book them" CTA, and a service row's "Book" button all land on `/book/{store_id}` with a different optional query param (§4). There's exactly one booking flow to maintain, never a parallel "quick book" path.
7. **Deposit/payment is V2 (`payment-deposit-preauth-design.md`'s own status tag) — V1 never shows a payment step, full stop.** An earlier version of this document treated Step 6 (Stripe Payment Element) as real, shipping V1 work; it isn't — payments/deposits were explicitly cut to backlog in the 2026-10-01/02 V1 scope decisions. `booking_settings.payment_required` stays in the schema (`create-appointment-transaction-design.md` §14's minimal hook: a reserved `payment_intent_id` column, nothing else) but V1 has no UI to turn it on and no provider wired up, so the flow is unconditionally Step 5 → Confirmation. When deposits actually ship, this decision — and Step 6 — get written for real against whatever `payment-deposit-preauth-design.md` looks like at that time.
8. **The phone-cap heads-up lives on the confirmation screen, after a successful booking — never as a pre-submit lookup.** A separate "check how many bookings this phone has" call, triggered as the customer types their number in Step 4, would be a standalone oracle: anyone could probe an arbitrary phone number's booking activity with no booking attempt required. Instead, the create endpoint's own response already carries `phone_upcoming_count` (`create-appointment-transaction-design.md` §3.1) — zero new queries, zero new endpoints, and the count is only ever disclosed to whoever just successfully booked with that number. The cost is timing: the customer learns they're near the cap one booking later than ideal (after their 5th succeeds, not while typing their 6th attempt) — acceptable, since "surprise" means learning only at the wall, and this always shows the heads-up at least once before that.
9. **A staff deep-link that's real but unqualified for the full basket degrades silently, never errors on load.** This is a deliberate narrowing of decision 6's general "deep links never break the funnel" rule to a case that rule didn't originally anticipate: the person exists (unlike an unknown `staff_id`, already ignored), they just can't do this specific combo. The preselection is dropped, the flow falls back to "Any available," and a non-blocking inline notice explains why ("{name} can't perform all selected services — showing everyone who can"). The hard `409 STAFF_NOT_QUALIFIED` (`create-appointment-transaction-design.md` §7) only exists as a create-time guard against a forced direct `POST` — it never fires from a page load, and this flow never shows it as a page-level error.
10. **A chain-level landing page is V1 (2026-10-02 decision).** A multi-store chain has nothing to put as a single entry point in an Instagram/Xiaohongshu/WeChat bio — every existing entry point (§5) is store-level. `GET /c/{chain_id}` (§5a) fills that gap: a read-only directory of the chain's stores that hands off to this same `/book/{store_id}` flow, never a second booking surface. A link-management center (copy link, regenerate, per-link click stats) is explicitly **not** part of this — V1.1.
11. **Attribution (`?src=`) is a free-text passthrough, not a closed list, and lives only on `/book/{store_id}`, never on `/c/{chain_id}`.** A booking link can carry `?src=<source>` (e.g. `instagram`, `xiaohongshu`, `wechat`); the value is recorded verbatim on the created appointment as `utm_source` (`create-appointment-transaction-design.md` §1 decision 14) so a store can tell which channel is actually converting. `appointments.channel` itself is untouched by this — it stays purely code-path-derived (that document's decision 12); a social-attributed booking is still, in every other respect, an ordinary `public_web` booking. The chain page (§5a) is deliberately a plain, unparameterized navigation hop with no attribution of its own — a chain can't yet attribute at the bio-link level in V1, only once a customer has picked a specific store and reached its `/book/{store_id}` link.
    **Known V1 gap, not an oversight:** a multi-store chain that puts its `/c/{chain_id}` link in a social bio (decision 10's whole reason to exist) gets no attribution on that traffic until a customer clicks through to a specific store — there is currently no way to tell "this click came from the Instagram bio" apart from any other chain-page visit. Passing a `?src=` received on `/c/{chain_id}` through onto each listed store's `[Book]` link (so `/c/{chain_id}?src=instagram` → every `[Book]` resolves to `/book/{store_id}?src=instagram`) would close this cleanly and cheaply. Deliberately left as a V1.1 item for the link management center (§1 decision 10) rather than snuck into this patch — tracked here explicitly so it isn't lost.

## 2. Flow

```
/book/{store_id}[?staff_id=xxx | ?service_id=xxx]   (§5 — optional preselection, service_id adds one item to the basket)
  Step 1 Service (basket, 1-5 items) → Step 2 Staff (intersection) → Step 3 Date/Time (combined block) → Step 4 Contact → Step 5 Review
    → Confirmation
```

(A payment step would sit between Review and Confirmation once deposits ship — V2, `payment-deposit-preauth-design.md`, §1 decision 7. V1's flow has no such step.)

A step indicator at the top allows back-navigation (prior selections are kept). Each step depends only on earlier selections; `store_id` stays in the URL throughout.

## 3. Steps

**Step 1 — Service (basket).** `GET /api/store/services?store_id=` (active, non-deleted, online-bookable only). Grouped by category; `from` services show "from $X" (live `MIN(options)`), `free` services show "Free." Each row gets an "Add" button rather than a single-select tap — a `from` service routes through its option picker before landing in the basket. A persistent basket bar shows item count, running total duration, and running total price; "Continue" is disabled until ≥1 item, enters Step 2 once the customer stops adding. Limits enforced client-side (and re-checked server-side, `create-appointment-transaction-design.md` §7): 2–5 items to continue with more than one, no duplicate service in the basket (the "Add" button for an already-basketed service shows "Remove" instead).

**Step 2 — Staff.** Options: "Any available" (default) plus the intersection of staff qualified for **every** item in the basket — a single-item basket's intersection is just that service's own staff list, so this is the same step either way, not a fork. Source: `GET /api/store/staff?store_id=&service_ids[]=` (§7 — promoted to V1-built by the multi-service brief; the single-service form keeps working). Selecting "Any" sends `staff_id: null` forward. If the basket shrinks the intersection to zero (no one qualified for all selected services), the list shows an explanatory empty state rather than nothing — "No one here can do this combination; try fewer services or ask the store directly."

**Step 3 — Date & time.** Date picker spans `today(store_tz)` through `today + advance_booking_days`; past dates disabled. On date selection: `GET /api/store/public/slots?store_id=&service_ids[]=&option_ids[]=&date=&staff_id=` (single-item basket uses the equivalent `service_id`/`option_id` form — same endpoint, same response shape either way, `availability-slot-engine.md` §1). The response's `total_duration_minutes` and re-sorted `services[]` (merchant execution order, not the customer's add order) drive the UI; times render at `slot_granularity_minutes` resolution, and the displayed block spans the whole basket, not one item. In "any staff" mode the UI shows only the time, not which staff member (kept for the confirmation screen — a customer who cares can pick a specific person in Step 2). No slots that day → "Fully booked today," with a one-tap jump to the next day.

**Step 4 — Contact.** Name and phone required; email optional (confirmation email only sent if present). Phone format-validated (Canadian 10-digit); no OTP in v1 — rate limiting already covers abuse, OTP is a v2 hardening. One line of copy, not a checkbox (it's not optional in practice): "Booking confirmation and reminders will be sent to this number."

Below that, **two independent, unchecked-by-default marketing-consent checkboxes** (2026-10-02 decision — one checkbox covering both channels was considered and rejected: CASL's burden of proof requires being able to show exactly what the customer agreed to, and one shared checkbox can't distinguish "agreed to SMS" from "agreed to email" if only one contact method was ever actually used):
- "Send me occasional offers and win-back messages by SMS" → `sms_marketing_consent`.
- "Send me occasional offers and win-back messages by email" → `email_marketing_consent`, shown/enabled only when an email address has been entered above (no point offering it with nothing to send to).

(Exact copy for both pending the CASL legal review already flagged for the reminders document.) Checking either box also sets `consent_text_version` (which copy they saw) and `consent_at` (when) on the create request — `create-appointment-transaction-design.md` §1 decision 13, §16 — the CASL evidence trail a bare boolean alone can't provide. Both map independently to the create request; this is V1 groundwork for V3's AI recall, with no V1 feature consuming the booleans yet. Transactional reminders are never gated on either box.

**Step 5 — Review.** Shows store name, every basket item in execution order (+ option where applicable), staff ("to be assigned" if "Any"), date/time for the combined block, total price, contact info. An optional "Anything we should know? / 备注" textarea, max 500 characters, sent as `notes` on the create request (2026-10-03, Part C — wires up `appointments.customer_notes`, which already existed but was always `null` until now). Server-side: trimmed, empty string normalized to `NULL`, over 500 characters → `400` (`create-appointment-transaction-design.md` §3.1). Submit button: "Confirm booking." Goes straight to Confirmation on success — there is no payment step in V1 (§1 decision 7).

**Non-empty notes force a `pending` result, even on an `auto_confirm=true` store (2026-10-03, Part C, `create-appointment-transaction-design.md` §1 decision 15).** The store gets a chance to look at what the customer wrote — allergy, special request, a question — before the booking takes effect, and calls if needed. This is invisible to the customer at submit time; it only changes what the Confirmation screen shows (below).

**Confirmation screen.** Large `reference_code`, booking details, "Confirmation sent to {phone}." Buttons: [Download calendar (.ics)] [Book another]. Copy: "To reschedule or cancel, call {store_phone}" (self-serve management is `customer-my-bookings-design.md`, not linked from here in v1). A `pending` result (`auto_confirm=false` stores, or non-empty `notes` forcing `pending` per decision 15 above — the two V1 causes of `pending` on this flow, since payment is V2) shows "Received — awaiting confirmation," matching the pending SMS template — **and, specifically when the client itself sent a non-empty `notes` value** (it already knows this, no new response field needed), extends that line to "Received — we'll call you to confirm the details." When the `201` response's `phone_upcoming_count` is at or above the cap minus one (default cap 5, so `count >= 4`), also show a non-blocking line: "Heads up: you now have {count} upcoming appointments with {store} — that's the limit for online booking, please call us for more." (§1 decision 8).

## 4. Submit request (Step 5 → Confirmation)

```
POST /api/store/public/appointments
Idempotency-Key: <uuid v4, generated on entering Step 5, held for that session>
{ store_id, items: [{service_id, option_id}, ...], staff_id, start, contact: {name, phone, email}, notes, sms_marketing_consent, email_marketing_consent, consent_text_version, consent_at, utm_source }
```

`items` carries the basket in whatever order the customer built it — the server re-sorts by `sequence_order` before sequencing (`create-appointment-transaction-design.md` §7); the client never needs to pre-sort it.

`utm_source` is whatever value the entry URL's `?src=` query param held (§5), captured once on page load and held for the whole flow the same way the `Idempotency-Key` is — `null` if the URL carried none. Passed straight through to `create-appointment-transaction-design.md` §1 decision 14; this flow never inspects or validates the value itself.

- Button disables on click and stays disabled until the response returns.
- `201` → confirmation screen (`reference_code`, `status`).
- `409 SLOT_TAKEN` → no error page: toast "That time was just taken," silently re-query that day's slots, restore Step 3 state with the refreshed list.
- `409 STAFF_NOT_QUALIFIED` → only reachable if a `staff_id` was forced through despite Step 2's intersection list (shouldn't happen via the UI itself, §1 decision 9) — same handling as `STAFF_NOT_AVAILABLE` below: return to Step 2, highlighted.
- `409 SERVICE_NOT_BOOKABLE` → return to Step 1 with the named offending item highlighted for removal (a service could go unbookable between Step 1 and submit — e.g. its last qualified staff member's live entries at this store were removed mid-flow).
- `409 CAPACITY_FULL` → **does not** silently refresh like `SLOT_TAKEN`: show an explicit message, "This time is fully booked — try another time," then re-query that day's slots (still auto-refreshed, just with a visible, distinct message rather than a quiet swap).
- `409 QUOTA_EXHAUSTED` → full-page message (billing §4.3 copy): "This store's monthly booking limit is reached — please call {store_phone}."
- `409 PHONE_LIMIT` → full-page message with the escape door spelled out (`create-appointment-transaction-design.md` §15 copy): "You've reached the limit of 5 upcoming bookings for this phone number — please call {store_phone} and we'll book you in right away." Not a silent retry — this phone number is capped chain-wide, re-querying slots won't help.
- `403 PHONE_BLOCKED` → full-page message, no override option on this channel (overriding is staff-only, `staff-manual-booking-calendar-design.md` §6): "We're unable to complete this booking online — please call {store_phone}."
- `409 STAFF_NOT_AVAILABLE` / `400`-series → return to the relevant step, highlighted.
- Network failure/timeout: **no automatic retry** — the user taps "Retry," which resends with the **same** `Idempotency-Key` (server-side dedup guarantees only one booking, test case §8.3).

## 5. Entry points

- Booking page URL: `/book/{store_id}`. In-store signage/QR code points at the same bare URL.
- Two optional deep-link variants, both landing on the same flow with a preselection:

| Entry | URL | Preselects |
|---|---|---|
| Store detail page [Book] | `/book/{store_id}` | Nothing |
| Staff profile [Book them] (`staff-profile-design.md` §1 CTA) | `/book/{store_id}?staff_id=xxx` | Staff for Step 2 — still changeable |
| Service row [Book] | `/book/{store_id}?service_id=xxx` | Adds that one service to the basket, pre-filled — still a 1-item basket the customer can add to or replace |

- An unknown or invalid `staff_id`/`service_id` is **ignored**, not a `400` — the flow starts at its ordinary default (empty basket, "Any available"). Deep links have to be fault-tolerant; a stale profile link or a since-deleted service shouldn't break the funnel.
- A `staff_id` that's real but not qualified for the basket as it stands is handled by §1 decision 9 (silently dropped to "Any available" + inline notice), not this ignore-outright rule — the two cases look similar but aren't the same thing: one is "this id doesn't resolve to anything," the other is "this id resolves to someone real who just can't do this."
- Unknown or non-`active` `store_id` → `404`, generic copy ("Online booking isn't available for this store"), no existence-leaking detail — this check runs regardless of which variant was used.
- Confirmation URL carries no sensitive data (`reference_code` is shown once on the page, never in the URL).

**Attribution — `?src=` (§1 decision 11).** Any of the three `/book/{store_id}` variants above also accepts an optional `&src=<source>` (e.g. `&src=instagram`), independent of and combinable with `staff_id`/`service_id` — e.g. `/book/{store_id}?service_id=xxx&src=xiaohongshu` is both a service preselection and an attributed link. The value is carried through as `utm_source` on the create request (§4) and stored verbatim on the appointment; an absent or unrecognized value is simply `null` — there's no fixed list to validate against. `/c/{chain_id}` (§5a) does **not** accept `src=` — attribution only exists once a customer reaches a specific store's booking link.

**Store-owner playbook: promo deep links.** `?service_id=xxx` preselection isn't just a URL convention for a developer to notice — it's the standard social play a store owner should actually use: post a promo on social (a seasonal service, a new offering) with a `?service_id=xxx&src=<platform>` link, and the customer who taps it lands straight in the booking flow with that service already in the basket, one step closer to confirming than if they'd had to find it themselves in Step 1's full list. This is worth a line in the store's own onboarding materials (`growayshop-registration-workflow.md`), not something left for an owner to reverse-engineer from the URL bar.

### 5a. Chain landing page (§1 decision 10)

`GET /c/{chain_id}` — public, no login, read-only. For a chain with more than one store, lists them (nearest-first when the visitor's geolocation is available, otherwise in the chain's own store-creation order), each row showing name, address, distance (when known), and a `[Book]` button linking to that store's `/book/{store_id}`. This page carries no booking or availability logic of its own — it is purely a directory that hands off to the one existing booking flow.

- **Single-store chain → `302` straight to `/book/{store_id}`.** There's nothing for a directory page to list, and forcing an extra click to see a list of one defeats the point of a single bio link.
- Unknown `chain_id` → `404`, same generic, existence-hiding copy as an unknown `store_id` (§5).
- A store with `status != 'active'` is omitted from the list entirely (not shown greyed-out) — same "don't advertise what can't be booked" posture as the map/detail pages. If every store in the chain is inactive, the page shows the chain name with a "no stores currently accepting online bookings" message rather than an empty list.
- No `?src=` support (§1 decision 11) — this page is never itself an attribution target.
- Not a new booking surface: this page's only interactive element is the `[Book]` link per store; everything past that click is the existing flow (§2–§4), unmodified.
- Link management (copy the chain link, regenerate it, per-link click stats, and passing a `?src=` received here through onto each listed store's `[Book]` link — §1 decision 11's known gap) is explicitly out of scope here — V1.1.

## 6. Responsive / UX notes (v1 minimum)

- Mobile-first, single column, large touch targets (≥44px) for time slots.
- Page language follows the browser; SMS language follows `customer-booking-confirmation-reminders-design.md`'s rules. i18n framework required from day one; copy ships in `en` + `zh`.
- Slot query shows a skeleton within 300ms; a timeout shows a retry button.

## 7. Interfaces consumed

| Step | Endpoint | Owning document |
|---|---|---|
| 1 | `GET /api/store/services` | `store-onboarding-v1-design.md` §7 |
| 2 | `GET /api/store/staff?service_ids[]=` (promoted to V1-built, no longer deferred) | `availability-slot-engine.md` §1 |
| 3 | `GET /api/store/public/slots` (multi-item form, §1/§3 of that document) | `availability-slot-engine.md` §7 |
| 5 | `POST /api/store/public/appointments` (`items[]` 1–5, response carries `phone_upcoming_count`, no separate lookup) | `create-appointment-transaction-design.md` §3.1, §6.3, §7 |
| Confirmation | `.ics` generated client-side | §1 decision 2 |
| SMS / Email | outbox → relay | `customer-booking-confirmation-reminders-design.md` |
| — | `GET /c/{chain_id}` chain landing page | §1 decision 10, §5a |

## 8. End-to-end test checklist

1. Full happy path: service → staff → time → contact → confirm → `201` → confirmation shows `reference_code` → SMS arrives within a minute.
2. Two phones race the same slot → one reaches confirmation, the other gets the toast and a refreshed list; no duplicate booking.
3. Weak network, triple-tap confirm → one booking (same `Idempotency-Key`).
4. Timeout then "Retry" → same `reference_code`, one DB row.
5. Free-plan quota exhausted mid-flow → call-to-action page, no orphaned appointment.
6. `auto_confirm=false` store → confirmation shows "awaiting confirmation," pending SMS received.
7. A store at capacity → booking a full window shows the `CAPACITY_FULL` message and a refreshed, narrower slot list; a non-`occupies_capacity` service still books normally in the same window.
8. Back navigation from Step 5 to Step 3, pick a different time → the booking uses the new time.
9. Expired date / invalid `store_id` → correct `400`/`404` page.
10. `/book/{store_id}?staff_id=<unknown>` and `?service_id=<unknown>` → the param is ignored, flow starts at its normal default, no `400`.
11. `/book/{store_id}?staff_id=xxx` from a staff profile → Step 2 opens preselected to that staff member, still changeable.
12. A store with `booking_settings.payment_required=true` → still no payment step shown (V1 has no UI path to meaningfully enable it); Step 5 goes straight to Confirmation regardless of this flag's value.
13. A phone's 5th successful booking → confirmation screen shows the heads-up line; its 6th attempt → full-page `PHONE_LIMIT` message with the escape-door copy, not a silent re-query.
14. A blocklisted phone → full-page `PHONE_BLOCKED` message, no retry/override control anywhere on this flow.
15. Basket of 2 services → Step 2's staff list shows only the intersection; slots at Step 3 are offered only where an intersection-staff member is free for the whole combined block; submitting creates one `appointments` row.
16. Services added to the basket in reverse of the merchant's `sequence_order` → Step 3's slots, Step 5's review, the created `appointment_items`, and the confirmation SMS's "A + B" summary are all in merchant order regardless of add order.
17. A staff member qualified for only one of two basket items → absent from Step 2's list; a stale `?staff_id=` deep link for that person → silently dropped to "Any available" with the inline notice (§1 decision 9), page loads normally, no error.
18. "Any available" with zero intersection-staff free for the combined block that day → empty `slots`, the ordinary "Fully booked today" copy, not an error page.
19. A 6-item basket, or attempting to add a duplicate service → blocked client-side before Step 1 even allows "Continue"; a request that somehow reaches the server with either problem → `400`, caught by `create-appointment-transaction-design.md` §7 regardless.
20. `/book/{store_id}?src=instagram` → the created appointment's `utm_source` is `"instagram"`; `/book/{store_id}` with no `src` → `utm_source` is `null`. Either way `channel` is `public_web`, unaffected (§1 decision 11).
21. `/book/{store_id}?service_id=xxx&src=xiaohongshu` → both effects apply together: Step 1 opens with that service pre-added, and the resulting booking's `utm_source` is `"xiaohongshu"`.
22. `/c/{chain_id}` for a two-store chain → a list of both stores, each `[Book]` linking to its own `/book/{store_id}`; the same URL for a single-store chain → `302` straight to that store's `/book/{store_id}`.
23. `/c/{chain_id}` for an unknown chain → `404`, generic copy; for a chain whose only store is `status != 'active'` → the "no stores currently accepting online bookings" message, not an empty list rendered as if nothing were wrong.
24. An `auto_confirm=true` store, booking submitted with non-empty Step 5 notes → confirmation shows "Received — we'll call you to confirm the details," not the normal confirmed screen. The same booking with the notes field left empty → confirmed immediately, as `auto_confirm` dictates.
25. Notes longer than 500 characters → `400` at submit, Step 5 stays active with the field highlighted.

## 9. Deferred

1. Logged-in member login / My Bookings link from the confirmation screen.
2. Deep links to Google/Apple calendar beyond plain `.ics`.
3. Tips (gratuity) — distinct from deposits.
4. Parallel/simultaneous multi-staff bookings (e.g. two technicians on one customer at once) — stays staff-manual, in-store request only (`V1Backlog.md`); never offered through this public flow.
5. **Deposit/payment collection (V2) — `payment-deposit-preauth-design.md` is the full design, kept ready, not built.** The whole Payment Element flow, the `payment_intent.succeeded` webhook, and the `payment_required` setting having any real UI consequence all wait for this to actually ship.
6. **Link management center (V1.1)** — copying a chain or store booking link, regenerating one that's leaked, per-link click statistics, and closing the chain-page attribution gap (§1 decision 11 — passing `?src=` from `/c/{chain_id}` through onto each store's `[Book]` link). §5/§5a's links work in V1; managing them as a first-class back-office feature doesn't.
