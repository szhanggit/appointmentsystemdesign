# Groway V1 Architecture — Canonical Reference

**All four workflow documents** (`user-registration-workflow.md`, `growayadmin-registration-workflow.md`, `growayshop-registration-workflow.md`, `growayshop-staff-invite-workflow.md`) **reference this document instead of restating its contents.** This is the one place the shared Gateway, database, Redis, queue, module-boundary, and authentication mechanics are defined. Each workflow document covers only what's specific to its own population: which Cognito Pool, which schema/tables, which flows.

---

## 1. The decision: modular monolith, not microservices

Groway has three fundamentally different populations — **Customers** (external, self-registering), **Store Users** (external chain/store admins and staff, manually onboarded), and **Groway Admins** (internal employees, highest privilege, cross-tenant). They are treated as **three security populations**, never as interchangeable rows in one shared user table.

V1 consists of:

- **One Gateway / BFF process**
- **Three application modules** — `Groway.Customer`, `Groway.Store`, `Groway.Admin` — each a bounded context with one authoritative owner per entity
- **Three Amazon Cognito User Pools** — Customer, Store, Admin
- **One Redis instance**, sessions tagged with a `population` field
- **One PostgreSQL instance, three schemas** — `customer`, `store`, `admin`
- **Three SQS queues + three KEDA-scaled consumers** — one per module, matching the three schemas
- **One application deployment**

```text
                         Groway
                           |
                    +------v------+
                    |   Gateway   |
                    |    / BFF    |
                    +------+------+
                           |
          +----------------+----------------+
          |                |                |
          v                v                v
   Customer Module   Store Module    Groway Admin Module
          |                |                |
          v                v                v
   customer schema   store schema     admin schema
          \                |                /
           +---------------+---------------+
                           |
                      PostgreSQL
```

The goal is not to simulate microservices in V1. The goal is a **modular monolith whose boundaries are strong enough that microservice extraction remains an engineering option later**, driven by an actual requirement (independent scaling, security isolation, deployment independence, team ownership, load differences) — never by architectural fashion.

---

## 2. Why not fully separate services (and why not one shared identity system either)

Two rejected alternatives, and why:

- **Fully separate Gateways/Redis/Postgres per population** (an earlier draft of this system) — correctly protects blast radius, but pays for it with three times the infrastructure to provision, monitor, and secure, and real cross-service network hops for anything one population needs to trigger in another (e.g. a Groway admin creating a store account). For a first version at modest scale, this is more operational cost than the isolation is worth.
- **One shared Cognito Pool / one shared session concept with a `role` column** — cheaper, but every endpoint would have to correctly reason about three incompatible authorization shapes forever (a customer's world has no concept of "other people's data" at all; Groway admin's is explicitly cross-tenant; a store user's is tenant-scoped). A single bug in shared authorization logic could leak one population's data into another's view — this is a correctness risk with no cheap way to catch it, because there's no structural boundary backing it up.

The modular monolith keeps the **structural boundary** (separate Cognito Pools, separate schemas, compiler-enforced module isolation) while sharing the **operational infrastructure** (one Gateway, one Redis, one Postgres instance) that doesn't actually need to be separate to get that boundary.

---

## 3. Physical project structure

```text
src/
├── Groway.Gateway          — HTTP routing, authentication, route groups, DTOs. No business logic.
├── Groway.Customer         — Customer Module implementation (internal types)
├── Groway.Customer.Contracts — public interfaces + DTOs other modules may reference
├── Groway.Store            — Store Module implementation (internal types)
├── Groway.Store.Contracts  — public interfaces + DTOs other modules may reference
├── Groway.Admin            — Admin Module implementation (internal types)
├── Groway.Admin.Contracts  — public interfaces + DTOs other modules may reference
└── Groway.Shared           — technical infrastructure only (see §9)
```

Each module has the same internal shape:

```text
Groway.Store/
├── API             — internal controllers/endpoint handlers, mapped under /api/store/*
├── Application      — use cases, commands, queries, authorization checks
├── Domain           — entities, value objects, domain rules
└── Infrastructure   — StoreDbContext, repositories, AWSSDK.CognitoIdentityProvider calls, SQS producer
```

Avoid unnecessary abstraction (`IRepository<T>`, `IGenericService<T>`, `IUnitOfWork`) unless there's a concrete reason. Prefer domain-specific interfaces (`IStoreUserService`, `IAppointmentService`).

---

## 4. Compiler-enforced module boundaries

Module boundaries are not a code-review convention — they're enforced by the compiler:

- `Groway.Store`'s `StoreDbContext`, repositories, and domain implementation classes are `internal`.
- Only `Groway.Store.Contracts` is public and referenceable by other modules — e.g. `IStoreUserService`, plus the request/result DTOs its methods use.
- `Groway.Customer` and `Groway.Admin` reference `Groway.Store.Contracts` (a small, dependency-free assembly), never `Groway.Store` itself.

```csharp
// Groway.Store.Contracts — public, tiny, no EF Core / infra dependencies
public interface IStoreUserService
{
    Task<CreateStoreUserResult> CreateStoreUserAsync(CreateStoreUserRequest request, CallerContext caller);
    Task DeactivateStoreUserAsync(Guid storeUserId, CallerContext caller);
    Task ReactivateStoreUserAsync(Guid storeUserId, CallerContext caller);
}

// Groway.Store — internal, the only thing that may touch StoreDbContext
internal sealed class StoreUserService : IStoreUserService { /* ... */ }
```

"Customer Module reaches into `StoreDbContext`" is a **compile error**, not a rule someone might forget. This is the concrete mechanism behind the modular-monolith rule that entities have exactly one owner and other modules reference them only by ID, never by direct query.

**This is also the extraction seam.** V1 registers `IStoreUserService` as an in-process singleton/scoped implementation:

```csharp
services.AddScoped<IStoreUserService, StoreUserService>(); // V1: in-process
```

Extracting Store into its own service later means swapping this one registration for an HTTP/gRPC client implementing the same interface:

```csharp
services.AddScoped<IStoreUserService, StoreUserServiceHttpClient>(); // future: network call
```

**No caller code changes.** Admin Module still calls `IStoreUserService.CreateStoreUserAsync(request, caller)` — it never knows or cares whether that's an in-process method call or an HTTP request under the hood. This is why `CallerContext` (§7) is passed as an explicit parameter rather than read from ambient `HttpContext` — an explicit parameter survives the swap to a network call unchanged; an ambient context does not.

---

## 5. Database: one instance, three schemas, no cross-schema foreign keys

```text
PostgreSQL
├── customer   (CustomerDbContext)
├── store      (StoreDbContext)
└── admin      (AdminDbContext)
```

- **Separate `DbContext` per module** (`CustomerDbContext`, `StoreDbContext`, `AdminDbContext`) — never one shared `GrowayDbContext`. Each context only knows about its own schema's tables.
- **Foreign keys within a schema are normal and encouraged** — e.g. `store.appointment_items.appointment_id → store.appointments.id` is a real, enforced FK; both tables are owned by Store and live in the same schema.
- **No foreign keys across schemas.** `store.appointment.customer_id` is an application-level reference to a row in `customer.customers`, never an enforced FK — Postgres cannot check it, and application code must. This is deliberate: when a schema is later extracted into its own database, a cross-schema FK becomes physically impossible, while an application-level reference degrades gracefully into an ordinary cross-service ID reference. The cost is real (no database-level protection against an orphaned reference) and is accepted for extraction-readiness — cover it with application-level tests that check for orphaned cross-module references, since Postgres won't.

---

## 6. Authentication: three Cognito Pools, one Gateway, route-group enforcement

### 6.1 Why three Cognito Pools, concretely

Customers, Store Users, and Groway Admins have different registration flows, attribute schemas, and challenge flows (Customer: self-service + phone-OTP custom-auth Lambda triggers; Store/Admin: invite-only + forced password change). Cognito Pools cost nothing extra to keep separate (no per-pool fee), so there's no operational argument against three pools the way there was against three Gateways/Redis/Postgres instances.

**Where the pool boundary actually bites:** this system never hands a client a raw Cognito-issued JWT (see §7) — so the boundary isn't "a per-request JWT gets rejected by the wrong pool." It's **identity non-existence**: a customer's identity simply does not exist as a user record in the Store or Admin pool. No routing bug could make Cognito successfully authenticate a customer as an admin, because Cognito has no such user to authenticate. This fires at the moment the Gateway calls Cognito (login, or any `Admin*` operation) — a runtime/identity boundary, not a per-request cryptographic check.

Each population's login/invite code path holds its **own** `IAmazonCognitoIdentityProvider` client, resolved via keyed DI:

```csharp
services.AddKeyedSingleton<IAmazonCognitoIdentityProvider>("customer", ...);
services.AddKeyedSingleton<IAmazonCognitoIdentityProvider>("store", ...);
services.AddKeyedSingleton<IAmazonCognitoIdentityProvider>("admin", ...);
```

Customer Module's login handler only ever resolves the `"customer"`-keyed client — there is no code path where it could reach the Store or Admin pool's credentials.

### 6.2 Opaque session tokens — not raw Cognito JWTs

Clients never hold a Cognito-issued token. Login produces a **Gateway-issued opaque Bearer token**, resolved against Redis (§7) on every request; the real Cognito tokens are cached server-side. This applies identically to all three populations — the mechanism doesn't change per population, only which Cognito Pool was used to obtain the underlying tokens.

### 6.3 Authentication schemes: one custom handler, three registrations

Since sessions are opaque (not JWTs), the "three authentication schemes" are three registrations of one custom `AuthenticationHandler`:

```csharp
services.AddAuthentication()
    .AddScheme<OpaqueSessionAuthOptions, OpaqueSessionAuthHandler>("CustomerSession", o => o.Population = "customer")
    .AddScheme<OpaqueSessionAuthOptions, OpaqueSessionAuthHandler>("StoreSession",    o => o.Population = "store")
    .AddScheme<OpaqueSessionAuthOptions, OpaqueSessionAuthHandler>("AdminSession",    o => o.Population = "admin");
```

`OpaqueSessionAuthHandler.HandleAuthenticateAsync`:
1. Read `Authorization: Bearer <token>`, hash it, `GET session:<hash>` from the shared Redis.
2. Not found / TTL elapsed → fail (401).
3. **Found, but `session.population != Options.Population` → explicit `Fail()`, logged as a security event** — a customer session hitting the admin scheme is a bug or an attack, either way worth an alert, never a silent pass-through.
4. Match → build the `ClaimsPrincipal`, succeed.

A fourth scheme, `"PartnerToken"`, validates real Cognito-issued JWTs from the M2M client-credentials flow (see `user-registration-workflow.md` §11) — the one case where a raw Cognito JWT genuinely is presented to the Gateway, because the caller is a server, not one of the three populations.

### 6.4 Route groups, fail-closed by construction

Every endpoint lives under exactly one of four prefixes — **no exceptions**:

```text
/api/customer/*   → CustomerSession
/api/store/*      → StoreSession
/api/admin/*      → AdminSession
/api/partner/*    → PartnerToken
```

```csharp
app.MapGroup("/api/customer").RequireAuthorization("CustomerPolicy");
app.MapGroup("/api/store").RequireAuthorization("StorePolicy");
app.MapGroup("/api/admin").RequireAuthorization("AdminPolicy");
app.MapGroup("/api/partner").RequireAuthorization("PartnerPolicy");
```
```csharp
services.AddAuthorization(o => {
    o.AddPolicy("CustomerPolicy", p => p.AddAuthenticationSchemes("CustomerSession").RequireAuthenticatedUser());
    o.AddPolicy("StorePolicy",    p => p.AddAuthenticationSchemes("StoreSession").RequireAuthenticatedUser());
    o.AddPolicy("AdminPolicy",    p => p.AddAuthenticationSchemes("AdminSession").RequireAuthenticatedUser());
    o.AddPolicy("PartnerPolicy",  p => p.AddAuthenticationSchemes("PartnerToken").RequireAuthenticatedUser());
});
```

This is the one central, auditable definition — four lines, not N endpoints each remembering their own `[Authorize(AuthenticationSchemes=...)]`.

**The gap this doesn't close on its own:** ASP.NET Core doesn't fail-closed globally — an endpoint mapped outside all four groups has no authentication requirement unless something enforces it. Don't patch this with a lenient `FallbackPolicy` (it can't tell "logged in" from "logged in as the right population"). Instead, add a **CI-time check**: enumerate every registered route at build/test time and fail the build if anything exists outside the four prefixes (plus an explicit allowlist like `/health`). This converts "a developer forgot" into a check nobody can skip.

### 6.5 Authorization context passed into modules

```csharp
public sealed record CallerContext(
    string Population,                          // "customer" | "store" | "admin"
    Guid PrincipalId,                            // customerId / storeUserId / adminId
    string? AppRole,                             // 'store' only: "chain_admin" | "store_admin" | "staff"
    IReadOnlySet<Guid>? AuthorizedStoreIds,       // 'store' only
    Guid? ActiveStoreId);                        // 'store' only
```

`chain_admin` (added 2026-09-28) is a third value of `AppRole` **within the existing `"store"` population** — it uses the same Store Cognito Pool, the same `StoreSession` authentication scheme, and the same `store.store_users` table as `store_admin`/`staff` (`growayshop-registration-workflow.md` §1). It is not a fourth population and does not introduce a new Cognito Pool, Gateway route group, or authentication scheme — the three-population model in §1 is unchanged. What changed is purely which stores a `"store"` session is authorized against: a `chain_admin`'s `AuthorizedStoreIds` covers every store in their chain, a `store_admin`'s covers exactly one.

Every cross-module interface method takes `CallerContext` as an explicit parameter. **The receiving module re-derives and re-checks authorization from `CallerContext` itself — it never trusts that the calling module already checked it**, because different modules check different things (Customer Module checks customer identity; Store Module must independently check store scope). This is the in-process form of "never trust a client-supplied ID as authorization proof" — applied at the module boundary, not just the web boundary.

---

## 7. Redis: one instance, population-tagged sessions

```json
{
  "sessionId": "...",
  "population": "customer",
  "principalId": "...",
  "appRole": null,
  "activeStoreId": null,
  "cognitoAccessToken": "...",
  "cognitoIdToken": "...",
  "cognitoRefreshToken": "...",
  "createdAt": "...", "lastUsedAt": "...", "expiresAt": "..."
}
```

One key pattern (`session:<sha256(opaque_token)>`), one TTL mechanism, across all three populations. Population-specific fields (`appRole`, `activeStoreId`) are simply null where irrelevant. Cognito tokens are application-level encrypted before writing, regardless of population — this was always required, not optional, and remains so.

Redis may be split later if a concrete requirement justifies it (independent scaling, security isolation, differing performance characteristics) — V1 does not duplicate it pre-emptively.

---

## 8. SQS + KEDA: three queues, one per module

Kept as three separate queues (`customer-activity-log`, `store-activity-log`, `admin-activity-log`), each with its own DLQ and its own KEDA-scaled consumer Deployment (0..N pods on queue depth) — matching the three schemas, not consolidated into one. Each module's own producer code (in-process, no network hop) publishes fire-and-forget; the response to the caller never waits on the message landing in its schema's activity-log table. Consumption is batched (`ReceiveMessage` up to 10, one multi-row `INSERT`, one `DeleteMessageBatch`) — not one message at a time. This mechanism is unchanged from earlier drafts of this system and is not re-explained per document.

KEDA requires Kubernetes; the application deployment (the one Gateway process, containing all three modules) runs on Amazon EKS, alongside the three independently KEDA-scaled consumer Deployments. This is the one place Kubernetes-specific tooling is used — it does not imply the application itself is split into multiple deployments.

---

## 9. Shared technical libraries — infrastructure only, never business logic

`Groway.Shared` may contain: authentication helpers, the `CallerContext` type, logging, correlation IDs, exception handling middleware, the SQS producer/consumer helper used identically by all three modules' activity-log pipelines. It must never contain business-domain logic (`Appointment`, `Chain`, `Store`, `Customer`, `Staff`) merely to avoid duplication — that recreates a distributed monolith inside a shared library, defeating the purpose of module ownership.

---

## 10. What does NOT trigger extraction

Do not extract a module merely because it has many classes/tables, a large domain, a separate UI, or because microservices seem cleaner. Extraction is justified by a concrete requirement: independent scaling, independent deployment, stronger security isolation, materially different operational/load characteristics, independent team ownership, reliability isolation, or a regulatory requirement. Absent one of those, the modular monolith stays as designed.

---

## 11. Rules for Claude Code

1. Do not introduce a new microservice without explicit architectural approval.
2. Do not introduce a Customer Gateway, Store Gateway, or Admin Gateway. There is one Gateway.
3. Do not introduce separate PostgreSQL instances. One instance, three schemas.
4. Do not introduce separate Redis instances. One instance.
5. Keep three separate Cognito User Pools.
6. Never let one module directly access another module's `DbContext` or repository.
7. Enforce module boundaries via separate assemblies/projects and `internal` implementation types (§4).
8. Every endpoint lives under `/api/customer/*`, `/api/store/*`, `/api/admin/*`, or `/api/partner/*` — no exceptions, enforced by a CI check (§6.4).
9. Never trust a client-supplied customer/store/store-user ID as authorization proof — always re-derive scope from `CallerContext`.
10. Never create cross-schema foreign keys without explicit approval.
11. Do not put business logic in the Gateway.
12. Prefer in-process module calls (via `*.Contracts` interfaces) over internal HTTP calls in V1.
13. Keep three separate SQS queues + KEDA consumers, one per module — do not consolidate.
14. Optimize for a simple, maintainable V1 while preserving the extraction seam described in §4.
