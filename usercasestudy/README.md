# Groway Design Documents — Index

This is the design-document set for Groway, a booking/scheduling SaaS platform built as a modular monolith (Store / Customer / Admin modules, one Postgres database with three schemas, three Cognito user pools, one Redis). Each document below is introduced with what it covers and how it depends on the documents before it.

The order below is an **idealized dependency order** — the sequence you'd build these in if starting from scratch today, each document resting on the concepts the ones above it already defined. It is not the literal order these documents were historically written or revised in.

## 1. Foundation

### [`groway-v1-architecture.md`](groway-v1-architecture.md)
The root document. Defines the modular-monolith shape (Store/Customer/Admin modules, one Gateway, three Cognito pools, one Postgres with three schemas, one Redis), the no-cross-schema-foreign-keys rule, and the extraction-ready module boundaries. Every other document assumes this shape without re-deriving it.

### [`store-onboarding-v1-design.md`](store-onboarding-v1-design.md)
The core data model: chains, stores, staff (person-level, not store-scoped), the service catalog (categories/services/options, price types, soft-delete, bookability), and store lifecycle (pending/active/suspended). This is the schema almost every later document reads from or writes into.

## 2. Identity & Accounts

### [`growayshop-registration-workflow.md`](growayshop-registration-workflow.md)
How a chain gets onto the platform: self-serve registration as the primary path (email verification, single-use token with a 7-day purge deadline) with admin-assisted onboarding as the exception path. Builds directly on the chain/store schema from `store-onboarding-v1-design.md`.

### [`growayadmin-registration-workflow.md`](growayadmin-registration-workflow.md)
Registration and account provisioning for Groway's own internal admin users — a parallel, smaller account workflow sitting alongside the store-side registration above, using the Admin Cognito pool from the architecture doc.

### [`growayshop-staff-invite-workflow.md`](growayshop-staff-invite-workflow.md)
How a store admin brings additional staff onto an already-registered chain/store. Depends on the account and permission model established in `growayshop-registration-workflow.md`.

### [`groway-admin-impersonation-design.md`](groway-admin-impersonation-design.md)
"Login as" tooling for Groway admins to act on behalf of a store for support purposes — no real session is minted; it's a UI wrapper over existing store-side APIs with a scoped action allow-list and mandatory notification. Depends on the account models from both registration workflows and the module-boundary rules from the architecture doc.

### [`user-registration-workflow.md`](user-registration-workflow.md)
Customer-side account registration, a separate population from store/admin in Cognito. Depends on the population model defined in `groway-v1-architecture.md`.

## 3. Scheduling & Slot Discovery

### [`staff-schedule-entry-workflow.md`](staff-schedule-entry-workflow.md)
How staff and store admins populate business hours, staff schedules, and time off — the raw availability data. Writes into tables defined in `store-onboarding-v1-design.md`.

### [`availability-slot-engine.md`](availability-slot-engine.md)
The slot-computation algorithm: reads schedules, time off, and the service catalog to produce bookable slots, including multi-service sequencing and capacity filtering. Depends on `store-onboarding-v1-design.md` for the schema and `staff-schedule-entry-workflow.md` for the data it queries.

## 4. The Booking Engine

### [`create-appointment-transaction-design.md`](create-appointment-transaction-design.md)
The core booking transaction: state machine, concurrency control (exclusion constraints, advisory locks), idempotency, multi-service sequencing, phone-cap/blocklist anti-abuse checks, and outbox events. This is the single creation path every booking surface (public, staff, future AI) funnels through. Depends on `availability-slot-engine.md` for re-validation and `store-onboarding-v1-design.md` for the underlying schema.

## 5. Commercial Layer

### [`pricing-tiers-v1.md`](pricing-tiers-v1.md)
The plan/pricing definitions (Free vs. Paid, quota levels) that the billing workflow enforces. Conceptually precedes the billing mechanism — this is the "what," the next document is the "how."

### [`groway-billing-workflow.md`](groway-billing-workflow.md)
Quota enforcement hooked into appointment creation, pooled-per-chain quota tracking, trial/downgrade flows, and proactive usage warnings. Depends on `pricing-tiers-v1.md` for the plan definitions and `create-appointment-transaction-design.md` for the enforcement hook point.

## 6. Customer Identity & Booking Flows

### [`customer-records-design.md`](customer-records-design.md)
Customer identity, search, guest-to-account claiming, and marketing-consent storage. Depends on `create-appointment-transaction-design.md` for the guest-snapshot columns it reconciles against and `growayshop-registration-workflow.md` for the chain-membership model.

### [`public-booking-end-to-end-design.md`](public-booking-end-to-end-design.md)
The full customer-facing booking flow (multi-service basket, consent checkboxes, confirmation), assembling `availability-slot-engine.md`, `create-appointment-transaction-design.md`, and `customer-records-design.md` into one end-to-end experience. Also owns the multi-store chain landing page (`/c/{chain_id}`, a directory that hands off into this same flow) and the `?src=` social-attribution query param.

### [`staff-manual-booking-calendar-design.md`](staff-manual-booking-calendar-design.md)
The staff-side back-office calendar and manual booking entry. Reuses the same creation transaction and customer records as the public flow, adding staff-specific permissions and blocklist-override UI.

### [`customer-my-bookings-design.md`](customer-my-bookings-design.md)
Customer self-service management of their own bookings (view/cancel/reschedule). Depends on the cancel/reschedule rules in `create-appointment-transaction-design.md` and the guest-lookup mechanics in `customer-records-design.md`.

## 7. Notifications

### [`customer-booking-confirmation-reminders-design.md`](customer-booking-confirmation-reminders-design.md)
The customer-facing notification pipeline (confirmations, reminders) that consumes the outbox events emitted by the booking transaction. Depends on `create-appointment-transaction-design.md` §12's event table.

### [`groway-store-notifications-workflow.md`](groway-store-notifications-workflow.md)
The store/chain-admin-facing message board (billing warnings, impersonation notices, system events). Depends on `groway-billing-workflow.md` and `groway-admin-impersonation-design.md` as its two main event sources.

## 8. Payments (V2)

### [`payment-deposit-preauth-design.md`](payment-deposit-preauth-design.md)
Deposit/pre-authorization design, explicitly scoped to V2. Hooks onto the minimal `payment_intent_id` reservation already present in `create-appointment-transaction-design.md` §14, but is not part of the V1 build.

## 9. Discovery & Public Map

### [`beauty-map-postgis-schema-design.md`](beauty-map-postgis-schema-design.md)
Geospatial schema groundwork for store discovery (PostGIS columns, indexing). Depends on the store address/location columns from `store-onboarding-v1-design.md`.

### [`beauty-map-nearby-search-design.md`](beauty-map-nearby-search-design.md)
The nearby-search API built on top of the PostGIS schema. Depends directly on `beauty-map-postgis-schema-design.md`.

### [`beauty-map-filtering-design.md`](beauty-map-filtering-design.md)
Filter semantics (category, price, availability) layered on top of nearby search. Depends on `beauty-map-nearby-search-design.md`.

### [`beauty-map-ui-design.md`](beauty-map-ui-design.md)
The customer-facing map/search UI consuming nearby-search and filtering. Depends on both documents above.

## 10. Profiles

### [`store-profile-enrichment-design.md`](store-profile-enrichment-design.md)
Store detail-page content: about text, photos, policies text, reviews. Depends on `store-onboarding-v1-design.md` for the base store record and `beauty-map-ui-design.md` as the primary entry point into this page.

### [`staff-profile-design.md`](staff-profile-design.md)
Staff public profiles (bio, photos, languages, stats). Scope is split: V1 ships the public page and admin-entered content only; self-service editing and its staged-column review workflow are V1.1, pending a not-yet-designed staff-facing "My Profile" page. Depends on `store-profile-enrichment-design.md` for the shared photo table and `public-booking-end-to-end-design.md` for the booking CTA deep link.

## 11. Backlog

### [`V1Backlog.md`](V1Backlog.md)
Forward-looking vision and deferred-scope tracking spanning every document above. Placed last deliberately — it's "what's next," not a dependency any V1 document above requires.
