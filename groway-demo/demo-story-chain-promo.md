# Demo Story 2 — Chain page → Instagram promo → attributed booking (~2 min)

Companion to `demo-story-claim.md` (Kevin Liu guest-booking claim, ~3 min).
This story shows distribution: how a chain turns a social post into a tracked booking.

## Setup

Open `client/chain.html` — the chain landing page (design route `/c/chain-selah`).
Point out: one link for the whole brand, works in an Instagram bio. Two locations,
each card with its own [Book].

## Beat 1 — The promo post (30s)

"Selah just posted a Reel: *Deluxe Royal Head Spa, this weekend only.* The link in
bio isn't the store page — it's a promo deep link:"
`client/book-1-service.html?service_id=svc-royal&src=instagram`

Open it. The **Deluxe Royal Head Spa card is already selected** (`#1 in sequence`),
and `src=instagram` is silently captured into the booking flow state.

## Beat 2 — The basket (30s)

Add **Aromatherapy Scalp Treatment**. Basket: 2 services, 2h 30m total, $218.
Note the sequence badges — `sequence_order` drives both the menu order and the
combo execution order. Continue.

## Beat 3 — One therapist (20s)

Only **Anna Chen** is offered: she's the intersection — the one therapist at this
store qualified for *both* services. Pick her. (Design rule: one technician
performs the whole basket.)

## Beat 4 — Time, details, consent (20s)

Pick a day and a start time — the basket runs as **one continuous 2h 30m block**.
On Details: guest checkout, no account needed. **Two consent checkboxes, both
unchecked by default** — tick SMS only. Independent CASL opt-ins.

## Beat 5 — Review + attribution (20s)

Review page: basket in sequence order, therapist, block, contact, consent states.
And the payoff line: **"Booking via: Instagram"** — the `?src=` attribution
carried through the whole flow into `utm_source`. Confirm.

## Beat 6 — Success (10s)

Big **reference code** (`K7Q2-M9XA` style, CSPRNG base32 in production).
"Confirmation SMS + email sent" — Twilio + SES in V1, for real.

## Close

"That Instagram Reel is now measurable: the store dashboard's notification feed
shows this booking tagged *via Instagram*. Distribution is the product."
