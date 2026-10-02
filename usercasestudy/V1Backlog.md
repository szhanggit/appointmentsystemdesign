
## V2/V3 vision (direction, not design — revisit after the V1 pilot)

Destinations, not specs. This section exists so V1 decisions can be checked against
a direction ("does this close off the AI future?"). Anything here that needs schema
gets a reservation line in the section above; behavior stays undesigned until its
version. Expect this section to be rewritten once V1 pilot data exists.

### V2 — monetization & retention (the business grows up)

> 2026-10-02: `appointments.channel`, booking-time marketing/AI-outreach consent,
> and `stores.policies_text` were approved into V1 scope — build checklist lives in
> the V1 groundwork brief (local file, handed to Claude Code separately).

- **[V2] Structured cancellation reasons** — AI gap-filling triggers on
  `appointment.cancelled` and needs the why: `customer_cancelled`, `no_show`,
  `staff_cancelled`, `rescheduled_away`. V1: emit the event with an extendable reason
  code (VARCHAR, not a closed enum). V2: the gap-fill consumer.
- **[V2] Waitlist, shaped for AI** — not a dumb notification list. Each entry needs:
  desired service(s), acceptable time windows, staff preference (or any), contact
  channel, expiry. Build it in V2 as "a list of phone numbers" and V3 AI gap-filling
  remodels it. (Already listed under Store operations — this is the shape constraint.)
- **[V2] Customer identity resolution** — AI recall lives or dies on "quiet 60+ days per
  real human." Guest bookings fragment identity (same phone, several guest rows). V2
  needs: hardened claim flow + a staff dedup/merge tool. The `customer_linked` event
  (reserved above) is the seam.
- **[V2] Full review system** — already listed under Customers. Feeds the AI front desk
  ("what do people say about…") and social proof. No new thought.
- **[V2] Member accounts, packages/memberships/gift cards, coupons, tips, reports &
  analytics, phone OTP step-up, keyword search, NEW badge, price bands, server-side
  clustering, admin console + impersonation UI, photo-moderation queue UI, chain-wide
  aggregate stats** — already listed under their headings. No new thought.
- No action: phone number as identity anchor — V1 already normalizes E.164 and counts
  per phone; the AI front desk's caller-ID → customer lookup rides on this for free.

### V3 — the AI layer (the exit-line bet)

V3 is the three exit-line criteria — AI 前台 + AI 填空位 + AI 召回 — built + deployed
+ **measured**, by 2027-03-28. Direction only; the design gets written after V1 pilot
data exists.

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
