# Progress

## M0: Skeleton

- Status: complete
- Monorepo workspace and strict TypeScript configuration created.
- Runtime service skeletons expose `/healthz`.
- Local MongoDB replica set, Redis, Kafka, Nginx, and web Compose services defined.
- CI runs tests, lint, and typecheck.
- M1 has not been started.

### Validation

- `pnpm test`: passed (1 test)
- `pnpm lint`: passed
- `pnpm typecheck`: passed
- `pnpm build`: passed for all 14 buildable workspace projects
- Prettier check: passed for M0 files
- Direct `/healthz` smoke test: passed for all seven runtime services
- `docker compose config --quiet`: passed
- `docker compose up -d`: passed; all 12 services started
- `docker compose ps`: passed; all 12 services reported healthy
- Nginx root route: passed; served the VoiceScore web placeholder
- Direct service health endpoints: passed in Compose for all seven runtime services

## M1: Engine

- Status: complete
- Implemented strict Zod schemas in `packages/schemas`.
- Implemented pure replay, validation, application, and clarified undo behavior in `packages/engine`.
- Added engine unit and property tests.
- Added Cricsheet conversion and staged replay validation in `packages/testkit`.
- Cricsheet validation snapshot: IPL JSON download used locally on 2026-11-08.
- Replay stages: 5/5 exact, 10/10 exact, 20/20 exact.
- Skipped matches: none.
- M2 is complete below.

## M2: Event store and command API

- Status: complete
- Added Zod command request validation and an in-memory EventBus implementation.
- Added synchronous scoring service with engine validation, idempotency, epoch fencing, optimistic sequence checks, and outbox records.
- Added MongoDB transactional event-store implementation with unique event, idempotency, and outbox indexes.
- Added match creation, scorer claim, and structured command HTTP routes.
- Tests cover idempotent retries, stale epochs, and concurrent sequence conflicts.
- M3 has not been started.
