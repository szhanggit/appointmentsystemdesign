# Customer Booking Confirmation & Reminders — Design

**Status:** the customer-facing notification pipeline. Consumes `create-appointment-transaction-design.md` §12's outbox events (`appointment.created/confirmed/cancelled/rescheduled/expired`). `chain_admin`'s own message board (blocked-booking digests, etc.) belongs to `groway-store-notifications-workflow.md` and isn't touched here.

Baseline: SMS via Twilio, email via SES (both already the chosen channels elsewhere in the project). Third-party cost is borne by the partner, not passed to the store in v1. All times are store-local; `reference_code` is the customer-facing booking number.

## 1. Decisions

1. **Two reminders: T-24h and T-2h.** 24h is enough time to reschedule; 2h guards against same-day forgetting; a third reminder would be nagging.
2. **Confirmation goes out by SMS + Email; reminders go out by SMS only.** SMS has the highest open rate; confirmation also needs a durable record (email), reminders just need to be seen.
3. **Quiet hours 21:00–08:00 (store timezone): no reminder SMS.** A reminder lands at 08:00 on the next poll instead of being skipped — a 3am reminder is pointless, but skipping it entirely means no reminder at all. Action-triggered messages (confirm/cancel/reschedule) are exempt — the customer just asked for it.
4. **Scheduling is a 5-minute poller, not a distributed scheduled-message system.** No scheduled-message infrastructure exists yet; a poller plus a "sent" flag is naturally idempotent and survives restarts.
5. **Bilingual templates (en/zh)**, by customer language preference, falling back to the store default.
6. **Cost is logged per message**, borne by the partner — no store-level cost allocation in v1.
7. **SMS STOP opt-out**: once opted out, SMS stops and falls back to email automatically; if neither channel is available, the send is logged only.

## 2. Event → notification mapping

| Outbox event | Notification | Channel | Timing |
|---|---|---|---|
| `appointment.created` (status=confirmed) | Booking confirmed | SMS + Email | Immediate |
| `appointment.created` (status=pending) | Received, awaiting confirmation | SMS (+ Email if available) | Immediate |
| `appointment.confirmed` | Booking confirmed | SMS + Email | Immediate |
| `appointment.cancelled` | Cancellation confirmed | SMS + Email | Immediate |
| `appointment.rescheduled` | Reschedule confirmed (new time) | SMS + Email | Immediate |
| `appointment.expired` | Held slot expired | SMS | Immediate |
| (scheduler) | 24h reminder | SMS | `starts_at - 24h` |
| (scheduler) | 2h reminder | SMS | `starts_at - 2h` |

- Event-driven notifications re-check the appointment's current status right before sending: if the relay is delayed and a `created(confirmed)` appointment has since been cancelled, send the cancellation message instead of a stale confirmation.
- Staff-created manual bookings (phone/walk-in) get the same notifications — the SMS carries `reference_code`, which is the customer's paper trail against "I was never told."

## 3. Reminder scheduler

A Kubernetes CronJob (same pattern as the billing-reminders job) polling every 5 minutes:

```sql
-- 24h reminder due: not yet sent, still confirmed, starts_at within the next 24h
SELECT id, store_id FROM store.appointments
WHERE status = 'confirmed'
  AND reminder_24h_sent_at IS NULL
  AND starts_at > now()
  AND starts_at <= now() + interval '24 hours';
-- 2h is symmetric (interval '2 hours', column reminder_2h_sent_at)
```

- A hit inside quiet hours (§4) is **not** marked sent — it's deferred to the next poll after 08:00, which picks it up normally.
- The sent-at column is written only on send success; a failed send leaves it unset so the next poll retries (§6).
- **A successful reschedule must clear `reminder_24h_sent_at`/`reminder_2h_sent_at`** if the new `starts_at` is more than 24h/2h away — otherwise the new time gets no reminder. This is the one piece of state `create-appointment-transaction-design.md` §10's reschedule path must also touch.
- Cancelled / no-show / expired appointments are naturally skipped (status isn't `confirmed`).

## 4. Quiet hours

- No **reminder** SMS between 21:00–08:00 store time; one due inside the window goes out on the first poll after 08:00.
- Action-triggered messages (confirm/cancel/reschedule) are **not** restricted — a cancellation confirmation waiting until morning would be absurd.
- Email is never restricted by quiet hours.

## 5. Channel rules

- **SMS is primary**: guest bookings already require a phone number, giving the best coverage. v1 sends from one shared Groway number; per-store numbers are v2.
- **Email is supplementary**: sent only if an address was given; confirm/cancel/reschedule get it, reminders don't.
- **Opt-out**: `store.customer_sms_opt_out(phone TEXT PRIMARY KEY, opted_out_at)`, written on the carrier's STOP callback. Checked before every send: opted-out → SMS skipped, email still sent; neither available → log only, no error.
- Every SMS includes opt-out instructions (§6 templates).

## 6. Templates

Template key format `{event}.{channel}`. Variables: `{store_name}` `{store_phone}` `{service_summary}` `{staff_name}` `{date}` `{time}` `{reference_code}` `{manage_link}`.

`{manage_link}` points to the self-serve lookup page (`customer-my-bookings-design.md` §4), pre-filled with this booking's `reference_code` via query param — e.g. `{booking_domain}/bookings?ref={reference_code}`. The phone-match check still runs on that page (§2 of that document); the link only saves re-typing the code, it does not bypass the ownership check.

Language: `customer.language ?? booking_settings.notification_lang` (default `en`; v1 supports `en`/`zh` only).

```
# booking.confirmed.sms
en: Hi {name}, your booking at {store_name} is confirmed: {service_summary} with {staff_name} on {date} at {time}. Ref {reference_code}. Manage or reschedule: {manage_link}. Reply STOP to opt out.
zh: {name}您好，您在{store_name}的预约已确认：{date}{time}，{service_summary}（{staff_name}），预约号{reference_code}。改期/取消：{manage_link}。回复 STOP 退订。

# booking.confirmed.email (subject)
en: Booking confirmed — {store_name}, {date} {time}
zh: 预约确认 — {store_name} {date} {time}

# reminder.24h.sms
en: Reminder: {store_name} tomorrow {time}, {service_summary} with {staff_name}. Ref {reference_code}. Need to change? {manage_link}
zh: 提醒：您明天{time}在{store_name}有预约，{service_summary}（{staff_name}），预约号{reference_code}。改期：{manage_link}

# reminder.2h.sms
en: See you soon! {store_name} today at {time}, {service_summary}. Ref {reference_code}.
zh: 期待您的光临！今天{time}，{store_name}，{service_summary}。预约号{reference_code}。

# booking.cancelled.sms
en: Your booking {reference_code} at {store_name} on {date} {time} has been cancelled. Hope to see you another time! {store_phone}
zh: 您{date}{time}在{store_name}的预约（{reference_code}）已取消，期待下次光临！{store_phone}

# booking.rescheduled.sms
en: Your booking has been moved to {date} {time} at {store_name}, {service_summary} with {staff_name}. New ref {reference_code}. Questions? {store_phone}
zh: 您的预约已改至{date}{time}，{store_name}，{service_summary}（{staff_name}），预约号{reference_code}。疑问请致电{store_phone}。

# booking.pending.sms (auto_confirm=false stores, or payment_required pending payment)
en: Hi {name}, we received your booking request at {store_name} ({date} {time}). We'll confirm shortly. Ref {reference_code}. Manage: {manage_link}
zh: {name}您好，我们已收到您在{store_name}的预约请求（{date}{time}），稍后为您确认。预约号{reference_code}。管理预约：{manage_link}

# booking.expired.sms
en: Hi {name}, your held slot at {store_name} ({date} {time}) has expired. Rebook anytime — we'd love to see you! {store_phone}
zh: {name}您好，您在{store_name}预留的时间（{date}{time}）已过期，欢迎重新预约！{store_phone}
```

- `{service_summary}`: single service = its name; multiple services = "A + B" (v1 shows the first two + "…" to avoid overlength).
- `{date}`/`{time}` format in store timezone (`Oct 5` / `10月5日`, `2:30 PM` / `下午2:30`).

## 7. Failure & retry

- Send worker: failure → exponential backoff (5m → 30m → 2h), marked `failed` after 3 attempts, no further retries.
- **Reminder-specific rule**: if a retry would fire after `starts_at` has already passed, mark `failed` immediately and skip — a late reminder is worse than none.
- **Dedup key includes an occurrence discriminator (2026-10-02 fix): `(appointment_id, event_type, channel, occurrence)`**, where `occurrence = appointments.reschedule_seq` at send time (`create-appointment-transaction-design.md` §16). The original two-part key `(appointment_id, event_type, channel)` only correctly deduplicates an outbox relay *replaying the same event* — it accidentally also suppressed a *second, legitimately distinct* occurrence of the same event type: a second reschedule's `rescheduled` confirmation collides with the first reschedule's row and never sends, and independently, a second round of 24h/2h reminders (after a later reschedule resets `reminder_24h_sent_at`/`reminder_2h_sent_at`, §3) collides with the first round's already-logged row the same way. `reschedule_seq` increments once per successful reschedule, so each distinct "version" of the appointment's schedule gets its own row; an outbox replay still carries the same `reschedule_seq` it always did, so true replays are still caught exactly as before.
- An outbox relay replay (true replay, same occurrence) is `ON CONFLICT DO NOTHING` — **never** resent.

```sql
CREATE TABLE store.notification_log (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id       UUID NOT NULL REFERENCES store.appointments(id),
  event_type           TEXT NOT NULL,   -- created/confirmed/cancelled/rescheduled/expired/reminder_24h/reminder_2h
  channel              TEXT NOT NULL CHECK (channel IN ('sms','email')),
  occurrence           INT NOT NULL DEFAULT 0,  -- appointments.reschedule_seq at send time
  recipient            TEXT NOT NULL,
  template_key         TEXT NOT NULL,
  lang                 TEXT NOT NULL,
  status               TEXT NOT NULL CHECK (status IN ('queued','sent','failed')) DEFAULT 'queued',
  provider_message_id  TEXT,
  cost_cents           INT,             -- from the provider's receipt; NULL if not yet returned, never blocks send
  error                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at              TIMESTAMPTZ,
  UNIQUE (appointment_id, event_type, channel, occurrence)
);
```

## 8. Cost tracking

- Every sent message logs `cost_cents` (Twilio/SES receipt).
- Summable by `store_id` (via `appointment_id → store_id`); v1 only logs, doesn't allocate — cost is the partner's (already settled), the table exists for a future "this store sends an unusual amount of SMS" conversation.
- The pricing document's free/paid tiers make **no** SMS-volume commitment — left open deliberately.

## 9. Compliance (CASL, Canada)

- Booking confirmations/reminders are **transactional messages within an existing business relationship**, not marketing — express consent isn't required, but every SMS still carries STOP opt-out, honored immediately (§5).
- Customer phone numbers are never used for marketing (AI win-back outreach is a separate feature with its own consent flow, out of scope here).
- This is an engineering read, not legal advice — templates get a lawyer's review before the partner's pilot launches.

## 10. Schema increment

```sql
ALTER TABLE store.appointments
  ADD COLUMN reminder_24h_sent_at TIMESTAMPTZ,
  ADD COLUMN reminder_2h_sent_at  TIMESTAMPTZ;

ALTER TABLE store.booking_settings
  ADD COLUMN reminder_24h_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN reminder_2h_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN notification_lang    VARCHAR(5) NOT NULL DEFAULT 'en';

CREATE TABLE store.customer_sms_opt_out (
  phone        TEXT PRIMARY KEY,
  opted_out_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- store.notification_log: see §7
```

The scheduler's query adds `AND reminder_24h_enabled` (read from that store's `booking_settings`), and symmetrically for 2h.

## 11. Test cases

1. Create a booking → confirmation SMS + Email within a minute, two `sent` rows in `notification_log`.
2. The relay replays the same event → `ON CONFLICT DO NOTHING`, customer receives it once.
3. An appointment tomorrow at 09:00 → 24h reminder arrives today around 09:00 (within poll-interval tolerance).
4. A 24h reminder due at 02:00 → sent on the first poll after 08:00, neither early nor skipped.
5. Create then immediately cancel → only the cancellation confirmation is received; no reminders follow.
6. Reschedule to a much later date → sent-at flags reset, both reminders fire normally for the new time.
7. SMS gateway down for 3 consecutive attempts → `failed`, no 4th attempt; an error is logged.
8. A STOP'd number → SMS skipped, email still sent; with neither available → one log row, no exception thrown.
9. An `auto_confirm=false` store → the customer receives the pending template, not the confirmed template.
10. An appointment is rescheduled twice → both `rescheduled` confirmation notifications are actually sent (two distinct `occurrence` values), not just the first.
11. An appointment is rescheduled (resetting `reminder_24h_sent_at`) and the new time is again >24h out → the second 24h reminder actually sends, distinct `occurrence` from the first round's already-logged row.
12. The outbox relay replays the same `appointment.rescheduled` event twice (same `reschedule_seq` both times) → still only one notification sent — the occurrence fix doesn't weaken true-replay dedup.

## 12. Deferred

1. Per-store SMS sender number / sender ID.
2. Per-store customizable reminder timing (v1 is fixed at 24h/2h plus on/off toggles).
3. Staff-side notifications (new-booking alerts to staff) — owned by the back-office calendar document.
4. No-show win-back outreach — belongs to a separate AI win-back feature, out of scope here.
