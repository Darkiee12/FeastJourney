# FeastJourney Documentation Index

**Read this first.** Docs express design intent; `AGENTS.md` expresses agent behavior. Each file has a narrow owner and purpose. Avoid duplicated rules.

## Product
- [Vision](product/vision.md): users, workflows, value proposition, explicit safety boundaries.
- [MVP delivery](product/mvp.md): 10-day scope, acceptance outcomes, deliberate exclusions.

## Architecture
- [Module organization](architecture/modules.md): canonical paths, owners and cross-module imports.
- [Guest/member access](architecture/access-control.md): actor policy and endpoint authorization.
- [System overview](architecture/overview.md): request flow and dependency boundaries.
- [SQL-first persistence](architecture/persistence.md): Reylo queries, Effect operations, transactions and module query ownership.
- [Contracts](architecture/contracts.md): shapes and ownership of cross-team APIs.
- [Data model](architecture/data-model.md): conceptual entities and provenance.
- [Effect conventions](architecture/effect.md): typed effects and adapter practices.
- [Maps and geosearch](architecture/maps.md): PostGIS, MapLibre React, TanStack SSR, tile/Places separation.
- [Effect domain modeling](architecture/domain-modeling.md): ADTs, tagged errors, request-scoped Actor and codec boundaries.
- [Authentication](architecture/authentication.md): Better Auth sessions, RBAC, token categories, revocation.
- [Recommendations](architecture/recommendations.md): public chooser pipeline, deterministic eligibility, Muse ranking, fallback semantics.
- [Trust and safety](architecture/trust-and-safety.md): food claims, privacy, media and AI risks.

## Infrastructure
- [Infra overview](infra/overview.md): local/production topology and responsibilities.
- [PostgreSQL](infra/postgres.md): persistence, privilege model, backups, restore.
- [Flyway migrations](infra/migrations.md): one-shot migration container, schema history, deployment gating and failure recovery.
- [Object storage](infra/object-storage.md): images, S3 API, security, retention.
- [Environment](infra/environment.md): configuration and secret handling.
- [Operations](infra/operations.md): local runbook and smoke checks.
- [Production deployment](infra/deployment-dokploy-azure.md): Azure VM + Dokploy + GHCR + Cloudflare Tunnel release contract (Proposed; Azure-side steps operator-verified).

## Agent coordination
- [Workflow](agents/workflow.md): agent roles, worktree coordination, shared files.
- [Definition of done](agents/definition-of-done.md): measurable completion criteria.
- [Task template](agents/task-template.md): copy for assignments.
- [Skill routing](agents/skills.md): what to load for UI, prototype, accessibility, motion and module-design work.

## Design
- [Mobile journeys](design/USER-JOURNEYS.md): mobile quiz drawer behavior and the synchronized globe push.

## Decision log
- [ADR index](decisions/README.md): recorded architectural choices.

## Development quality
- [Quality gates](development/quality-gates.md): Oxlint, Oxfmt, type checks, UI verification and CI behavior.
- [Code style](development/code-style.md): enforced clarity patterns (Reylo cardinality, query-owned result types, no mechanical DTO mapping, SQL-first projections, companion-object APIs, `runQuery`, errors and retry).
- [Database testing](development/database-testing.md): PostgreSQL/Flyway checks and Reylo test prerequisites.

## Reference material
- [Sources](references.md): canonical external documentation and researched repositories.

## Documentation update rule
Change the canonical document for a concern. Update links and decisions if a contract changes. Do not add speculative files that nobody will read. If a statement is not yet verified, label it `Proposed` or `Unverified`.
