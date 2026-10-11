# V1 Backlog

> **V1 design freeze: PENDING — Steven is reviewing the design (as of 2026-10-02).**
> This is not frozen yet. Do not treat the design as final until the freeze
> marker below is replaced with a frozen stamp. Once Steven signs off, the
> amendment rule applies: an implementation-discovered design bug gets a dated
> amendment note (what changed, why, which commit) — either in the affected
> doc's own amendment log or here. A doc that no longer matches the running
> code is worse than no doc.

Everything not in V1 scope lives here. **Rule:** when an item is promoted into
V1, its design moves into the relevant `usercasestudy/` doc and the line is
deleted here — a backlog that still lists shipped features is a lie.

## Booking, payments & trust

- Customer deposit payment (客户付定金) — full design in
  `payment-deposit-preauth-design.md` (V2; V1 only reserves the schema seam,
  `create-appointment-transaction-design.md` §14).
- Tips (gratuity) — distinct from deposits.
- Pre-auth hold.
- Phone OTP step-up for guest booking (v1 uses rate limiting only).
- Parallel/simultaneous multi-staff bookings (e.g. two technicians on one customer
  at once) — stays staff-manual, in-store request only; never offered through the
  public flow.
- Per-room/per-bed assignment (v1: store-level capacity number only).
- Coupons.

## Customers

- Full review system (write + display; v1 hides ratings entirely).
- min_rating surfacing / rating filters.
- Member accounts (login).
- Favorites.

## Beauty map discovery

- Keyword search.
- 30-day NEW badge.
- Nearby recommendations.
- Price bands / amenity flags.
- Server-side clustering.
- Marker branding / navigation deep-links.

## Store operations

- Reports & analytics.
- Marketing (campaigns; the booking-time consent columns are the V1 groundwork
  for this).
- Waitlist — AI-shaped, not a dumb notification list (see the V2 shape
  constraint in "V2/V3 vision" below).
- Packages / memberships / gift cards.
- Photo moderation queue UI (the staff-profile R1/R8 staging gate exists in v1;
  the Groway-side review UI is backlog).
- Chain-wide aggregate stats.
- ~~Test appointments (`appointments.is_test` + 🧪 badge + quota exemption) — DEFERRED
  from the V1 build (2026-10-03, Steven). Competitor check: none of Fresha / Vagaro /
  Mindbody / Booker / Square / GlossGenius has a test-appointment concept — they train
  on live accounts and don't meter bookings, so they never needed one. V1 training
  story: practice bookings on the live store (they consume quota; acceptable at
  100/mo) or train pre-launch. Design stays in the docs; the V1 build skips the
  column, the badge, and the exemption. Revisit post-pilot if training demonstrably
  burns quota.~~ — **REMOVED entirely 2026-10-05 (Steven), not merely deferred.** This
  backlog entry no longer applies: the full design (schema column, badge, quota
  exemption) is deleted from every design doc, not parked here for later. If this
  is ever genuinely needed, it's a boolean column plus one branch — half a day's
  work — and the full prior design is preserved in git history, not lost by removing
  this line.

## Platform & accounts

- Groway admin console (cross-tenant dashboard).
- 'Login as' impersonation UI (protocol designed in
  `groway-admin-impersonation-design.md`; the admin-side UI is backlog).
- category-taxonomy / spoken-languages / abuse_config admin UIs.

## Med-aesthetics clinical module

- Charting, consent forms, before/after photos, practitioner credential checks,
  stricter deposits, treatment packages. **Legal review required before storing
  any health data (PHIPA)** — see the reservation below.

## AI layer

- AI front desk, AI gap-filling, AI recall — the exit-line bet. Direction lives
  in "V2/V3 vision" below; zero design docs by design until V1 pilot data exists.

## V1 architectural reservations (seams V1 must not close)

Rule: reserve the seam, don't build the room. When a reservation is consumed
(the feature gets built), delete the line here and in the V1 groundwork brief
(local file, handed to Claude Code separately).

1. `appointments.payment_intent_id TEXT` + `payment_status`
   (`none|awaiting|succeeded|failed|refunded|partially_refunded`) — columns exist
   from day one so V2 deposits/pre-auth need no backfill.
2. `store.messages` uses the `system_subtype` pattern — a new system-generated
   message kind never widens `message_type`'s enum.
3. `platform.spoken_languages` (BCP 47) stays permanently independent from the
   customer notification language — never "unify" them.
4. No cross-schema foreign keys, ever — cross-module references are
   application-level IDs (extraction-ready).
5. `appointment.customer_linked` domain event is emitted even with no V1 consumers.
6. `stores.geo_place_id` kept on every address write (future provider migration).
7. Impersonation `ticket_ref` rule is forward-looking — suspend/refund aren't built,
   but ticket-required enforcement applies automatically the day they are.
8. One person, multiple chains = separate logins; no cross-chain session.
9. "Merchant" terminology stays retired/reserved — do not reuse for chain/store.
10. Med-aesthetics tables must be isolatable (encryption, audit logs, hard
    permissions); **legal review before storing any health data (PHIPA).**
    (Forward-looking for the dedicated clinical tables; `customer.customers.notes`
    is constrained to operational preferences only in v1.)

## V2/V3 vision (direction, not design — revisit after the V1 pilot)

Destinations, not specs. This section exists so V1 decisions can be checked against
a direction ("does this close off the AI future?"). Anything here that needs schema
gets a reservation line in the section above; behavior stays undesigned until its
version. Expect this section to be rewritten once V1 pilot data exists.

### V2 — re-sequenced 2026-10-04 (Steven): foundation → AI core → market test, then backfill or kill

**The sequencing bet.** V1 is the foundation (打地基) — non-negotiable, must be solid. After V1 + pilot data, the next thing built is the AI core, not the V2 monetization list. Rationale: whether the AI can attract merchants is the project's existential question — the riskiest assumption. V2's deposits / memberships / portal / reviews are optimizations on a business that only matters if the AI bet lands. If the AI core pulls merchants → backfill V2b's detail items. If it can't → the project terminates. This is "riskiest assumption first," not "most features first."

**The pilot-data gate still stands.** Zero AI design until V1 pilot data exists (unchanged). What changes is only what comes *after* the gate: AI enablers first, pure monetization later.

**Kill criteria are set before the AI build starts, not by feel at the end.** The exit line gives the date (2027-03-28); the bar needs numbers decided upfront — e.g. N pilot merchants live, $X measurable AI-attributed revenue ("earned you $X last month") by that date. If the bar isn't met, the project terminates rather than drifting into backfilling V2b on hope.

> 2026-10-02: `appointments.channel`, booking-time marketing/AI-outreach consent,
> and `stores.policies_text` were approved into V1 scope — build checklist lives in
> the V1 groundwork brief (local file, handed to Claude Code separately).

#### V2a — AI enablers (pulled forward, built right after the pilot)

Only the items the AI core actually needs. Original entries preserved verbatim, retagged:

- **[V2a] Structured cancellation reasons** — AI gap-filling triggers on
  `appointment.cancelled` and needs the why: `customer_cancelled`, `no_show`,
  `staff_cancelled`, `rescheduled_away`. V1: the event carries `cancelled_by`
  (customer/staff/system) only — no reason-code column (2026-10-02 ruling: a
  VARCHAR no V1 UI populates stays NULL forever; the taxonomy is a V2 addition
  with its own capture UI). V2: the gap-fill consumer.

- **[V2a] Waitlist, shaped for AI** — not a dumb notification list. Each entry needs:
  desired service(s), acceptable time windows, staff preference (or any), contact
  channel, expiry. Build it in V2 as "a list of phone numbers" and V3 AI gap-filling
  remodels it. (Already listed under Store operations — this is the shape constraint.)

- **[V2a] Customer identity resolution** — AI recall lives or dies on "quiet 60+ days per
  real human." Guest bookings fragment identity (same phone, several guest rows). V2
  needs: hardened claim flow + a staff dedup/merge tool. The `customer_linked` event
  (reserved above) is the seam.

- **[V2a] Customer profiles** — NEW, promoted from the V1.1 backlog (Customers section). Recall needs a profile to win back to; identity resolution needs a record to resolve into.

#### V2b — pure monetization & maturation (deferred until the AI core proves market pull)

None of these block the AI. They get built only if the market test passes:

- **[V2b] Full review system** — already listed under Customers. Feeds the AI front desk
  ("what do people say about…") and social proof. No new thought.

- **[V2b] Member accounts, packages/memberships/gift cards, coupons, tips, reports &
  analytics, phone OTP step-up, keyword search, NEW badge, price bands, server-side
  clustering, admin console + impersonation UI, photo-moderation queue UI, chain-wide
  aggregate stats** — already listed under their headings. No new thought.

- **[V2b] Staff self-service portal (Fresha parity)** — each staff member gets their
  own login: sees their own schedule/shifts, their performance, and their
  commission/earnings summary. 2026-10-02 research: Fresha has this (own login +
  workspace, per-sale commission calc, pay-period summaries); byChronos has commission
  calc but no staff-facing login found; COSReady has none. Retention play: staff care
  most about "what do I take home" — transparency keeps them. Needs: staff auth
  (exists in V1), per-store stats (V1.1 ruling), a commission model (V2).
  Design intent (Steven, 2026-10-02): **chain-level login** — one login, a
  membership list across the chain's stores, and a store switcher; every action is
  scoped to the currently selected store (default = last-selected, mirroring
  chain_admin's is_primary default). Per-store permissions come from the
  assignment's descriptive role at each store.

- No action: phone number as identity anchor — V1 already normalizes E.164 and counts
  per phone; the AI front desk's caller-ID → customer lookup rides on this for free.

- **[V2b] Downgrade reason capture** — NEW 2026-10-06 (Steven). When a chain moves
  from paid back to free, ask why. V1: downgrade is human-handled ("V1 不提供自助降级",
  2026-10-05) so the reason is captured in the manual flow; when self-service
  downgrade lands, prompt in-flow. Churn reasons feed retention and win-back.

- **[V2b] Marketing SMS/email campaigns with audience segmentation** — NEW 2026-10-08
  (Steven; from a call with byChronos). byChronos model: marketing SMS at US$100
  minimum top-up = 4,000 messages (≈ US$0.025/SMS); sends go to segmented groups —
  (1) lapsed customers (no visit in 3/6 months), (2) birthday month, (3) all.
  Marketing emails are free but blast-only (no segmentation). Pricing reference for
  Groway: byChronos ≈ US$0.025/msg vs raw Twilio Canada toll-free ≈ US$0.0129/segment —
  ~2× markup is the market anchor for our own per-tier SMS allowance (open question
  in the pricing doc). Overlap note: manual segmented campaigns are the V2b stepping
  stone; V3 AI recall (quiet 60+ days win-back) is the automated version. Consent seam
  already exists: V1 captures booking-time marketing/AI-outreach consent (2026-10-02).
  Product split (byChronos): marketing SMS is a *separate product* from notification
  SMS (reminders/confirmations) — it requires contacting customer service for a manual
  top-up before use. Groway should keep the same split: notification SMS rides the
  subscription allowance; marketing SMS is a separate paid bucket (also cleaner for
  CASL — marketing consent is separate from transactional consent).

- **[V2b] Online gift-card sales (Stripe, Canada-capable)** — NEW 2026-10-10
  (Steven; from byChronos WeChat promo screenshots). byChronos launched online
  eGift Card sales (Oct 2026): the merchant puts a purchase link on their own
  website, the customer pays online, the merchant receives the order and manually
  creates the e-gift card in-system to send to the customer. Differs from in-store
  gift cards (in-person purchase + payment) — the new part is the online payment
  channel. **Canada NOT supported: payment runs through Zelle (US bank accounts
  only).** Groway angle: a Stripe-based equivalent is Canada-capable from day one —
  the differentiator isn't "has gift cards" (byChronos already sells them in-store)
  but "works in Canada." Design notes: payment webhook should auto-issue the card
  (byChronos's version is semi-manual — merchant creates the card after the order
  arrives); gift-card balances are chain liability, same accounting care as deposits
  (chain's own Stripe account, not Groway's). Overlap note: "gift cards" already
  listed under Store operations — this entry is the online-sale channel variant.

### V3 — the AI layer (the exit-line bet)

V3 is the three exit-line criteria — AI 前台 + AI 填空位 + AI 召回 — built + deployed
+ **measured**, by 2027-03-28. Direction only; the design gets written after V1 pilot
data exists.

> 2026-10-04 (Steven) — thinnest market-test slice first: the exit line still requires all three (front desk + gap-fill + recall, built + deployed + measured), but the market test doesn't wait for the full set. The thinnest cut is AI front desk answering calls 24/7 → bookings, plus one measurable revenue number ("earned you $X last month"). Complete the set after the slice proves pull.

- **[V3] AI front desk** — answers calls/messages 24/7, books into the calendar through
  the same agent-callable APIs (idempotency keys are already V1). Needs: the V2
  knowledge base (`policies_text` + catalog), conversation memory, a human-escalation
  path, and **per-chain AI cost metering** — the partner bears AI API costs under the
  funding agreement, so usage must be attributable per chain for the bill.
- **[V3] AI gap-filling** — cancellation detected → best-fit waitlisted customer offered
  the slot → booking attributed `ai_gapfill`. Needs: the V2 AI-shaped waitlist, V2
  cancellation reasons, the V1 `channel` column.
- **[V3] AI recall** — quiet 60+ days → personalized win-back ("Anna has an opening
  Thursday — she did your last shellac"). Needs: V2 identity resolution, V2 consent,
  the V1 `channel` column. Staff affinity derives from `appointments.staff_id` —
  explicitly no new V1 column needed.
- **[V3] Measurement is the feature** — "front-desk time saved" needs a pre-AI baseline
  measured operationally during the pilot (not software). "Filled slots" and "recovered
  customers" come from the `channel` column. If it can't be measured, it doesn't count
  toward the exit line.
- **[V3] Conversation logs & model lineage** — every AI touchpoint logs model version,
  prompt version, I/O summary, cost. Needed for debugging, cost control, and (for voice)
  potential compliance. V3 infra; V1/V2 just don't prohibit it.
- **[V3] Thin revenue-per-staff report** — NEW 2026-10-04 (Steven). Sums completed-appointment service price snapshots per staff per period (revenue only — no commission-model rules, no pay-period logic). The full commission/earnings model (rates, pay periods) stays V2b under the staff self-service portal. All source data exists in V1 (`appointments` + item price snapshots); this is a small reporting build, no new capture needed. Rationale: pilot visibility into what each technician sold, without waiting for the full payroll feature.

