# agent.md: VoiceScore, a voice-first cricket scorer

> Build spec for AI coding agents (Claude Code, Cursor, Codex). Rename to `AGENTS.md` or `CLAUDE.md` if your tool expects that name.
> Read this whole file before writing code. Work milestone by milestone (section 17). Do not skip ahead.
> "VoiceScore" is a working title. Rename freely.

---
## 0. Prototype scope (overrides everything below)

We are building a working prototype, not a production system.
- Build only M1, M2, M3, M5, in that order. Skip M4, M6, M7, M8, M9.
- Run one replica of each service. No load balancing work, no replica testing.
- Keep the architecture and the rules in section 2 unchanged.
- Cricsheet validation: 10-20 matches is enough.
- Voice eval: 30 labeled cases; report the measured number, do not claim a target.
- Prefer working and simple over hardened. Skip rate-limit tuning, chaos tests, and dashboards.
- Done when: one phone scores by voice, at least two other phones update live within about 1 s, and undo works. Demo through an HTTPS tunnel.

## 1. What we are building

A scoring app for local cricket (gully, college, club). The scorer **speaks** ("chauka, cover drive", "wicket", "wide"), and the live scoreboard updates on every viewer's phone within about a second. After the match, the app writes a shareable summary.

- **Scorer** (one per match): PWA on a phone. Voice input, big-button fallback, undo, works offline.
- **Viewers** (many per match): open a link, no login, see live score, scorecard, and commentary.
- **AI's only job**: turn a spoken phrase into one structured command. A deterministic cricket engine decides if it is legal. AI never writes scores.

---

## 2. Non-negotiable rules for the agent

1. **The event log is the source of truth.** A match is an append-only list of events. Score state is always derived by replaying events through the pure engine. Never store or edit score state as the primary record.
2. **The LLM proposes, the engine disposes.** LLM output is validated with Zod, then validated by `packages/engine`. If either fails, reject. The LLM never touches the database.
3. **Scoring commands are synchronous.** Never put the scorer's write path behind a queue. The scorer needs an immediate accept or reject. Kafka starts *after* an event is committed.
4. **Every consumer is idempotent.** Delivery is at-least-once. Dedupe on `(matchId, seq)`.
5. **Every queue and buffer is bounded.** No unbounded in-memory arrays or queues. Shed load with 429/503 and `Retry-After`.
6. **Per-match ordering comes from `seq`**, assigned inside the DB write, guarded by a unique index on `(matchId, seq)`.
7. **No business logic in the gateway or realtime service.** Cricket rules live only in `packages/engine`.
8. **One milestone at a time.** Do not build features from later milestones. At the end of each milestone: run all tests, update `docs/progress.md`, summarize, then stop and wait.
9. **TypeScript strict mode, no `any`.** Validate every external input (HTTP, socket, Kafka, LLM) with Zod at the boundary.
10. **Do not change decisions in section 19 (Key decisions) without asking.** Add an ADR in `docs/adr/` when proposing a change.
11. Add a dependency only with a one-line justification in the PR description.
12. Tests first for `packages/engine`. No engine change merges without a test.

---

## 3. Architecture

```
   Phones: scorer PWA / viewer PWA
            |  HTTPS + WSS
            v
   +----------------------+
   | Nginx  (L7 LB, TLS)  |  least_conn, WebSocket upgrade, health checks
   +-----+-----------+----+
         | /api      | /socket.io
         v           v
   +-----------+   +-------------------+
   | Gateway xN|   | Realtime xN       |  Socket.IO + Redis adapter
   | auth,     |   | rooms: match:{id} |  consumes Kafka -> emits to rooms
   | rate limit|   +---------^---------+
   +-----+-----+             |
         v                   |
   +---------------+         |            +---------------------------+
   | Scoring API xN|         +------------|          KAFKA            |
   | commands,     |                      | match.events  (key=match) |
   | lease, engine |                      | match.lifecycle           |
   +---+-------+---+                      | *.dlq                     |
       |       |                          +-----^---------^-----------+
       |       v                                |         |
       |   +-----------+      +-------------+   |    +----+---------+
       |   | Parser xN |      | Outbox relay|---+    | Projector    |
       |   | fast path |      +------^------+        | Report worker|
       |   | + LLM     |             |               +--------------+
       |   +-----------+             |
       v                             |
   +----------------------------------+--+      +----------------------------+
   | MongoDB (replica set)               |      | Redis                      |
   | events, outbox, matches, reports    |      | rate limit, scorer lease,  |
   +-------------------------------------+      | scoreboard cache, ring     |
                                                | buffer, socket.io adapter  |
                                                +----------------------------+
```

### Why each piece exists

| Piece | Job | What breaks without it |
|---|---|---|
| Nginx LB | Spread load, terminate TLS, upgrade WebSockets, drop dead nodes | Single point of failure, no horizontal scaling |
| Gateway | Auth, rate limit, request ID, routing | Every service re-implements auth and abuse protection |
| Scoring API | Validate and commit commands | Nothing to protect score correctness |
| Parser service | Isolate the flaky, slow LLM dependency | LLM latency or outages take down scoring |
| Kafka | Durable buffer and fan-out after commit | Slow consumers (reports, projections) hurt the write path |
| Outbox relay | Guarantee committed events reach Kafka | Events saved but never broadcast |
| Redis | Fast shared state (locks, cache, rate limits, ring buffer) | Cross-instance coordination gets slow or wrong |
| MongoDB | Durable event store | No source of truth |

**Honest note:** at gully scale, the load alone does not need Kafka. We include it on purpose: it gives clean decoupling and is the right shape for growth. Keep it behind the `EventBus` interface (section 13) so tests and early milestones can use the in-memory implementation.

---

## 4. Services

| Service | Port | Stateless? | Scales by | Notes |
|---|---|---|---|---|
| `nginx` | 80/443 | yes | replicas | Edge LB |
| `gateway` | 4000 | yes | CPU | JWT verify, Redis rate limit, proxies `/api/*` |
| `scoring-api` | 4001 | yes | CPU | Command pipeline, event store writes |
| `parser` | 4002 | yes | LLM concurrency | Fast path regex, then LLM, circuit breaker |
| `realtime` | 4003 | holds sockets | connections | Socket.IO, Kafka consumer group `realtime` |
| `projector` | n/a | yes | partitions | Group `projector`, builds scoreboard cache |
| `outbox-relay` | n/a | yes | 1-2 replicas | Polls outbox, publishes to Kafka |
| `report-worker` | n/a | yes | partitions | Group `report`, LLM match report |
| `web` | 5173 | static | CDN | React PWA |

---

## 5. Request flows

### 5.1 Scorer records a ball (synchronous path, target p95 under 250 ms fast path)

1. Scorer speaks. Browser speech recognition produces a transcript.
2. `POST /api/matches/:id/commands` with `Idempotency-Key`, `epoch`, `source`, `transcript` or structured input.
3. Gateway: verify JWT, rate limit, attach `requestId`, forward.
4. Scoring API:
   1. Check scorer lease epoch (fencing).
   2. Idempotency check on `(matchId, clientEventId)`. If seen, return the stored result.
   3. Load events (Redis cache keyed by `lastSeq`, else Mongo) and replay to get current state.
   4. If `source = voice`: call Parser (timeout 2.5 s). Fast path first, LLM second.
   5. `engine.validate(state, command)` returns events or a rule violation.
   6. **Mongo transaction:** insert events with `seq = lastSeq + 1..n`, insert matching outbox docs. Unique index conflict returns 409; retry once after reload.
   7. Respond `201` with the new events and a state summary.
5. Outbox relay publishes to Kafka `match.events` (key = `matchId`).
6. Projector updates the scoreboard cache. Realtime consumes and emits to the room.
7. Viewers receive the event. Scorer UI shows an "undo" chip for 3 s.

### 5.2 Viewer joins or reconnects

1. Client opens the socket, sends `join { matchId, lastSeq }`.
2. Realtime sends `snapshot` (scoreboard cache) then replays events with `seq > lastSeq` from the Redis ring buffer.
3. If the gap is larger than the ring buffer (or `lastSeq` unknown), send a fresh snapshot only.
4. Client dedupes by `seq`.
5. **Degraded mode:** if the socket fails 3 times, the client polls `GET /api/matches/:id/events?afterSeq=N` every 3 s.

### 5.3 Async jobs (Kafka)

- `MATCH_COMPLETED` on `match.lifecycle` triggers the report worker.
- The worker computes stats deterministically from the event log (engine), then asks the LLM to write a narrative from those stats only. The LLM never invents numbers.
- Failure: retry 3 times with backoff, then publish to `match.lifecycle.dlq`.

---

## 6. Data model

### 6.1 MongoDB (replica set required for transactions)

| Collection | Key fields | Indexes |
|---|---|---|
| `events` | envelope (see 6.2) | **unique** `(matchId, seq)`, **unique sparse** `(matchId, clientEventId)` |
| `outbox` | `eventId`, `topic`, `key`, `payload`, `publishedAt?` | `(publishedAt, _id)` partial where `publishedAt` is null |
| `matches` | `_id`, `slug`, `ownerId`, `rules`, `status`, `scorerEpoch`, `createdAt` | unique `slug`, `ownerId` |
| `scoreboards` | `matchId`, `seq`, `state` | unique `matchId` (durable copy of projection) |
| `reports` | `matchId`, `statsJson`, `narrative`, `createdAt` | unique `matchId` |
| `users` | `_id`, `email`, `name` | unique `email` |
| `voice_logs` | `transcript`, `context`, `parsed`, `accepted`, `ts` | TTL 90 days (used for evals) |

### 6.2 Event envelope (`packages/schemas`)

```ts
export type EventType =
  | 'MATCH_CONFIGURED' | 'TOSS' | 'INNINGS_STARTED'
  | 'BATTER_SET' | 'BOWLER_SET' | 'BALL'
  | 'UNDO' | 'INNINGS_ENDED' | 'MATCH_COMPLETED';

export type EventEnvelope<T = unknown> = {
  eventId: string;          // uuid v7
  matchId: string;
  seq: number;              // per match, gapless, starts at 1
  type: EventType;
  schemaVersion: 1;
  ts: string;               // ISO, server time
  clientEventId?: string;   // idempotency key from the client
  actor: { userId: string; role: 'scorer' | 'system' };
  payload: T;
};

export type BallPayload = {
  runsOffBat: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  isBoundary?: boolean;     // distinguishes "four" from four run all-run
  extra?: { type: 'wide' | 'noball' | 'bye' | 'legbye'; runs: number };
  wicket?: {
    kind: 'bowled' | 'caught' | 'lbw' | 'runout' | 'stumped' | 'hitwicket' | 'retired';
    batterOutId: string;
    fielderId?: string;
  };
  shot?: string;            // free text, e.g. "cover drive"
  source: 'voice' | 'button';
  transcript?: string;
};
```

- `UNDO { targetSeq }` marks an earlier event as void. Nothing is ever edited or deleted.
- Consumers ignore unknown fields. Breaking changes bump `schemaVersion` and add an upcaster in the engine.

### 6.3 Match rules (house rules are first class)

```ts
export type MatchRules = {
  overs: number;
  playersPerSide: number;
  ballsPerOver: 6;
  wideRuns: number;          // gully rules vary
  noballRuns: number;
  freeHitOnNoBall: boolean;
  lastManStands: boolean;
  maxOversPerBowler?: number;
};
```

### 6.4 Redis keys

| Key | Purpose | TTL |
|---|---|---|
| `lease:match:{id}` | Scorer lease, value `userId:epoch` | 30 s, renewed by heartbeat |
| `sb:{matchId}` | Scoreboard snapshot JSON | none while live, 24 h after end |
| `ring:{matchId}` | Last 200 events (list) | 24 h after end |
| `evcache:{matchId}:{lastSeq}` | Cached event list for replay | 60 s |
| `rl:{scope}:{id}` | Rate limit counters | window |
| `parse:{hash}` | Cached normalized utterance to command | 1 h |

---

## 7. Kafka design

| Topic | Key | Partitions | Retention | Producer | Consumer groups |
|---|---|---|---|---|---|
| `match.events` | `matchId` | 12 | 7 d | outbox-relay | `projector`, `realtime` |
| `match.lifecycle` | `matchId` | 3 | 30 d | outbox-relay | `report` |
| `match.events.dlq` | `matchId` | 3 | 30 d | any consumer | manual replay |
| `match.lifecycle.dlq` | `matchId` | 3 | 30 d | report worker | manual replay |

- Key = `matchId` keeps one match on one partition, so one match is processed in order.
- Producer: `acks=all`, idempotent producer on, send in batches (linger 5 ms).
- Consumer: manual offset commit **after** processing. Retry 3 times with exponential backoff (200 ms, 400 ms, 800 ms), then publish to the DLQ with error headers and commit.
- Consumers per group should not exceed the partition count.
- Delivery guarantee: **at-least-once**. Exactly-once is out of scope. Idempotent consumers cover it.
- Library: `kafkajs`.
- Local replication factor 1. Production 3 with `min.insync.replicas=2`.

### Outbox relay

1. Poll `outbox` where `publishedAt` is null, ordered by `_id`, batch of 100.
2. Publish to Kafka, then set `publishedAt`. A crash between the two causes a duplicate publish, which consumers handle.
3. Run 1-2 replicas. Use a per-batch claim (`findOneAndUpdate` with a short `claimedUntil`) so replicas do not double-publish constantly.

---

## 8. Buffering and backpressure

Every buffer below is bounded. Each one has a defined overflow behavior.

| # | Buffer | Where | Bound | On overflow |
|---|---|---|---|---|
| B1 | Offline event queue | Scorer PWA, IndexedDB | 500 events | Block new scoring, show "sync required" |
| B2 | Request limits | Gateway | token bucket per match and per IP | `429` + `Retry-After` |
| B3 | Durable buffer | Kafka | retention + disk | Alert on consumer lag, scale consumers |
| B4 | Reconnect ring buffer | Redis `ring:{matchId}` | last 200 events | Fall back to snapshot |
| B5 | Emit coalescing | Realtime | flush every 100 ms per room | Slow client over 50 events behind gets a snapshot, intermediate events dropped |
| B6 | Parser queue | Parser | 8 concurrent LLM calls, wait queue of 50 | Return `PARSE_BUSY`, UI shows buttons |
| B7 | Outbox | Mongo | unpublished count | Alert if oldest unpublished age is over 10 s |

**Offline sync (B1):** events carry local sequence and `clientEventId`. On reconnect, replay in order with exponential backoff and jitter. Server dedupes by `clientEventId`. The shared engine package runs in the browser, so the scorer UI stays fully usable offline.

---

## 9. Load balancing and gateway

### 9.1 Nginx (`infra/nginx/nginx.conf`)

```nginx
worker_processes auto;
events { worker_connections 10240; }

http {
  map $http_upgrade $connection_upgrade { default upgrade; '' close; }

  upstream gateway_up  { least_conn; server gateway:4000  max_fails=3 fail_timeout=10s; keepalive 64; }
  upstream realtime_up { least_conn; server realtime:4003 max_fails=3 fail_timeout=10s; }

  server {
    listen 80;

    location /socket.io/ {
      proxy_pass http://realtime_up;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection $connection_upgrade;
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_read_timeout 3600s;
    }

    location /api/ {
      proxy_pass http://gateway_up;
      proxy_http_version 1.1;
      proxy_set_header Connection "";
      proxy_set_header Host $host;
      proxy_set_header X-Request-Id $request_id;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_connect_timeout 2s;
      proxy_read_timeout 10s;
    }

    location / { proxy_pass http://web:5173; }
  }
}
```

Notes:
- Sticky sessions are **not** needed. Socket.IO uses the Redis adapter, and each client reconnects with `lastSeq`.
- In Docker Compose, Nginx resolves `gateway` to all replica IPs at startup. After scaling, run `docker compose restart nginx`, or configure `resolver 127.0.0.11` with variables for dynamic resolution.
- Graceful shutdown: every service handles `SIGTERM`: stop accepting, drain in-flight requests, close sockets with a "reconnect" hint, commit Kafka offsets, exit.

### 9.2 Gateway responsibilities (and nothing more)

- Verify JWT (viewers are anonymous and read-only).
- Rate limit with a Redis token bucket:
  - Scorer commands: 10/s per match.
  - Viewer REST: 30/min per IP per match.
  - Global: 200/s per IP.
- Request ID, structured access log, CORS allowlist, `helmet`, 16 KB body limit.
- Route `/api/matches/:id/commands*` to scoring-api, `/api/matches/:id/(scoreboard|events|report)` to the read handlers, auth routes to scoring-api.
- Timeouts: 10 s upstream. A circuit breaker per upstream returns `503` fast when open.
- Add `Cache-Control: public, max-age=1, stale-while-revalidate=5` on scoreboard GETs so a CDN or Nginx cache can absorb viewer reads.

---

## 10. API contracts

All bodies validated with Zod from `packages/schemas`. Errors use `{ error: { code, message, details? } }`.

### REST

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/auth/login` | none | Email magic link or Google login, returns JWT |
| POST | `/api/matches` | scorer | Create a match with `MatchRules` and teams |
| POST | `/api/matches/:id/scorer/claim` | owner | Claim the lease, returns `{ epoch }` |
| POST | `/api/matches/:id/scorer/heartbeat` | scorer | Extend lease |
| POST | `/api/matches/:id/commands` | scorer | Submit a command (below) |
| GET | `/api/matches/:id/scoreboard` | public | Cached snapshot with `seq` |
| GET | `/api/matches/:id/events?afterSeq=N` | public | Polling fallback, max 200 per call |
| GET | `/api/matches/:id/report` | public | Narrative and stats once ready |
| GET | `/healthz`, `/readyz` | none | Liveness and readiness on every service |

### Command body

```ts
type CommandRequest = {
  clientEventId: string;     // also sent as Idempotency-Key header
  epoch: number;             // scorer lease epoch (fencing token)
  source: 'voice' | 'button';
  transcript?: string;       // when source = voice
  command?:                  // when source = button, or after voice parse
    | { kind: 'record_ball'; ball: Omit<BallPayload, 'source' | 'transcript'> }
    | { kind: 'undo_last' }
    | { kind: 'set_bowler'; playerId: string }
    | { kind: 'set_batter'; playerId: string; role: 'striker' | 'non_striker' };
};
```

Responses: `201 { events, state }`, `400` malformed, `409` seq conflict or stale epoch, `422` rule violation (with a human-readable reason), `429` rate limited, `503` parser busy or dependency down.

### Socket.IO

- Client to server: `join { matchId, lastSeq }`, `leave { matchId }`.
- Server to client: `snapshot { seq, state }`, `event { envelope }`, `batch { envelopes }` (coalesced).

---

## 11. Cricket engine (`packages/engine`)

Pure TypeScript. **No I/O, no clock, no randomness.** Runs on server and in the browser.

```ts
validate(state: MatchState, cmd: Command): Result<EventEnvelope[], RuleViolation>
apply(state: MatchState, e: EventEnvelope): MatchState     // pure
replay(events: EventEnvelope[]): MatchState                // honors UNDO
```

Must handle (each with tests):
- Legal vs illegal deliveries: wide and no-ball add runs, do not count as a ball, and are re-bowled. Free hit after a no-ball (configurable).
- Byes and leg byes. Overthrows. Boundary vs all-run four.
- Wicket kinds. Run out requires choosing which batter. Retired batters.
- Strike rotation: odd runs, end of over, wides do not rotate unless runs are run.
- Over completion forces `awaiting: 'NEW_BOWLER'`. A wicket forces `awaiting: 'NEW_BATTER'`. While `awaiting` is set, ball commands are rejected.
- Innings end: overs done, all out (`playersPerSide - 1` wickets, or last man stands), target chased.
- Bowler over limits. Same bowler cannot bowl consecutive overs.
- Result calculation: win by runs, win by wickets, tie.
- `UNDO` restores state exactly. Undo of an undo is not allowed. Undo across an over boundary works.

Out of scope: DLS, super over, powerplay fielding restrictions.

**Property tests:** (1) `replay` is deterministic. (2) `apply` then undo equals the previous state. (3) Total runs equal the sum of event runs. (4) No sequence of valid commands produces more balls than the rules allow.

---

## 12. Voice parsing (`apps/parser`)

Pipeline:

1. **Normalize:** lowercase, strip fillers, map Hinglish and number words.
2. **Fast path (regex and dictionary):** handles the majority of balls with zero latency and zero cost.
   - `dot, 0, ek, 1, do, 2, teen, 3, four, chauka, 4, six, chakka, 6, wide, no ball, bye, leg bye, wicket, out, bowled, caught, lbw, run out, stumped, undo`
3. **LLM path:** only if the fast path does not match. Use function calling with these tools: `record_ball`, `undo_last`, `set_bowler`, `set_batter`, `ask_clarification`. Temperature 0. Include match context (striker, bowler, over, ball, known player names) and a few Hinglish examples in the prompt.
4. **Validate:** Zod on the tool call. Then return to scoring-api, which calls the engine.
5. **Resilience:**
   - Timeout 2.5 s. Circuit breaker (`opossum`): open after 5 failures in 30 s, half-open after 15 s.
   - Concurrency limit 8 and a bounded wait queue of 50 (buffer B6).
   - Cache normalized transcript to parsed command in Redis for 1 h.
   - When the breaker is open or the queue is full: return `PARSE_BUSY`. The UI switches to buttons. Scoring never blocks on the LLM.
6. **Logging:** write `(transcript, context, parsed, accepted)` to `voice_logs` for evals.

### Voice eval (`evals/voice/`)

- `cases.jsonl`: at least 100 labeled utterances (English, Hindi, Hinglish, noisy variants). Fields: `transcript`, `context`, `expected`.
- `pnpm eval:voice` prints exact-match accuracy, split by fast path and LLM path, plus p50 and p95 latency.
- Target: 90% or higher exact match. CI fails if accuracy drops more than 2 points below the stored baseline.

### Speech input (client)

- Use the browser `SpeechRecognition` API with `en-IN` and `hi-IN`. Support is best on Chrome and Android. iOS Safari is limited, so the button UI is always available.
- Note for the privacy page: browser speech recognition may send audio to the browser vendor's servers. We only send the **transcript** to our backend and never store audio.

---

## 13. Shared packages

```
packages/
  engine/      pure cricket rules (section 11)
  schemas/     Zod schemas and TS types: events, commands, API
  eventbus/    EventBus interface + KafkaEventBus (kafkajs) + InMemoryEventBus
  config/      env parsing with Zod
  logger/      pino with requestId / matchId fields
  testkit/     Cricsheet loader, fixtures, event builders
```

```ts
interface EventBus {
  publish(topic: string, key: string, value: unknown, headers?: Record<string,string>): Promise<void>;
  subscribe(topic: string, group: string, handler: (msg: Msg) => Promise<void>): Promise<void>;
}
```

---

## 14. Repo layout

```
.
├── agent.md
├── apps/
│   ├── web/             React 18 + Vite PWA, socket.io-client, idb, TanStack Query
│   ├── gateway/         Express + http-proxy-middleware
│   ├── scoring-api/     Express, MongoDB native driver, ioredis
│   ├── parser/          Express, fast path + LLM + opossum
│   ├── realtime/        Socket.IO + @socket.io/redis-adapter + Kafka consumer
│   ├── projector/       Kafka consumer, writes scoreboards
│   ├── outbox-relay/    Polls outbox, publishes to Kafka
│   └── report-worker/   Kafka consumer, stats + LLM narrative
├── packages/            (section 13)
├── infra/
│   ├── docker-compose.yml
│   ├── nginx/nginx.conf
│   └── kafka/create-topics.sh
├── evals/voice/
├── loadtest/            k6 scripts
├── docs/
│   ├── progress.md
│   └── adr/
└── pnpm-workspace.yaml
```

Stack: Node LTS (22+), TypeScript strict, pnpm workspaces, Vitest, ESLint, Prettier, Zod, pino, prom-client, Docker Compose.

---

## 15. Local infrastructure

`infra/docker-compose.yml` (trimmed; pin exact image tags and verify them when you set up):

```yaml
x-node: &node
  restart: unless-stopped
  env_file: .env
  depends_on: [mongo, redis, kafka]

services:
  nginx:
    image: nginx:stable
    ports: ["80:80"]
    volumes: ["./nginx/nginx.conf:/etc/nginx/nginx.conf:ro"]
    depends_on: [gateway, realtime, web]

  gateway:      { <<: *node, build: { context: .., dockerfile: apps/gateway/Dockerfile },      deploy: { replicas: 2 } }
  scoring-api:  { <<: *node, build: { context: .., dockerfile: apps/scoring-api/Dockerfile },  deploy: { replicas: 2 } }
  parser:       { <<: *node, build: { context: .., dockerfile: apps/parser/Dockerfile },       deploy: { replicas: 2 } }
  realtime:     { <<: *node, build: { context: .., dockerfile: apps/realtime/Dockerfile },     deploy: { replicas: 2 } }
  projector:    { <<: *node, build: { context: .., dockerfile: apps/projector/Dockerfile } }
  outbox-relay: { <<: *node, build: { context: .., dockerfile: apps/outbox-relay/Dockerfile } }
  report-worker:{ <<: *node, build: { context: .., dockerfile: apps/report-worker/Dockerfile } }
  web:          { build: { context: .., dockerfile: apps/web/Dockerfile } }

  mongo:
    image: mongo:7
    command: ["--replSet", "rs0", "--bind_ip_all"]
    healthcheck:
      test: ["CMD", "mongosh", "--quiet", "--eval",
             "try{rs.status().ok}catch(e){rs.initiate({_id:'rs0',members:[{_id:0,host:'mongo:27017'}]}).ok}"]
      interval: 5s
      retries: 20

  redis:
    image: redis:7

  kafka:
    image: apache/kafka:3.8.0
    environment:
      KAFKA_NODE_ID: 1
      KAFKA_PROCESS_ROLES: broker,controller
      KAFKA_LISTENERS: PLAINTEXT://:9092,CONTROLLER://:9093
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://kafka:9092
      KAFKA_CONTROLLER_LISTENER_NAMES: CONTROLLER
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT
      KAFKA_CONTROLLER_QUORUM_VOTERS: 1@kafka:9093
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1
      KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: 1
      KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: 1
```

`infra/kafka/create-topics.sh`:

```bash
T=/opt/kafka/bin/kafka-topics.sh; B=kafka:9092
$T --bootstrap-server $B --create --if-not-exists --topic match.events        --partitions 12 --replication-factor 1 --config retention.ms=604800000
$T --bootstrap-server $B --create --if-not-exists --topic match.lifecycle     --partitions 3  --replication-factor 1 --config retention.ms=2592000000
$T --bootstrap-server $B --create --if-not-exists --topic match.events.dlq    --partitions 3  --replication-factor 1
$T --bootstrap-server $B --create --if-not-exists --topic match.lifecycle.dlq --partitions 3  --replication-factor 1
```

Commands:

```bash
pnpm install
docker compose -f infra/docker-compose.yml up -d
docker compose -f infra/docker-compose.yml up -d --scale scoring-api=3
pnpm test               # unit + property tests
pnpm test:replay        # Cricsheet replay (see section 16)
pnpm eval:voice         # voice parsing accuracy
pnpm loadtest           # k6
pnpm lint && pnpm typecheck
```

---

## 16. Reliability, security, observability

### 16.1 Failure modes

| Failure | Behavior |
|---|---|
| Kafka down | Scoring continues (commit to Mongo plus outbox). Viewers fall back to polling. Relay drains the backlog on recovery. |
| Outbox relay down | Same as above. Alert when the oldest unpublished event is over 10 s old. |
| Redis down | Rate limits fail open for viewers, closed for scorer commands. Event cache bypassed (read Mongo). Fencing still works through the unique `(matchId, seq)` index and `scorerEpoch`. |
| Mongo down | Scoring returns `503`. The scorer client keeps buffering offline (B1). Viewers still read cached snapshots. |
| Parser or LLM down | Circuit opens. Scorer uses buttons. No data loss. |
| Realtime node dies | Clients reconnect through the LB, send `lastSeq`, and catch up from the ring buffer. |
| Duplicate delivery | Dedupe by `clientEventId`, `(matchId, seq)`, and consumer-side `seq` checks. |
| Two scorers at once | Lease plus epoch fencing. Stale epoch gets `409`. Takeover is an explicit owner action that increments `scorerEpoch`. |
| Poison message | 3 retries, then DLQ with error headers. Never block the partition. |

### 16.2 Security and privacy

- JWT access token (15 min) plus refresh. Scorer routes require match ownership.
- Viewers: read-only, unguessable `slug` (nanoid, 10 chars). Private matches are a later feature.
- Zod validation on every boundary. 16 KB body limit. CORS allowlist. `helmet`.
- Secrets only in environment variables. No secrets in the repo.
- Store transcripts only (`voice_logs`, TTL 90 days). Never store audio. Do not log full JWTs.
- Cricsheet data: check its license terms and attribute it in the README.

### 16.3 Observability

- `pino` JSON logs with `requestId`, `matchId`, `seq`. Propagate `requestId` through Kafka headers.
- `prom-client` metrics on `/metrics`:
  - `command_latency_seconds` (histogram), `parse_latency_seconds{path=fast|llm}`, `parse_accuracy` (from evals)
  - `kafka_consumer_lag{group,topic}`, `outbox_oldest_unpublished_seconds`
  - `ws_connections`, `ws_emit_batch_size`, `rate_limited_total`, `breaker_state`
- `/healthz` (process alive) and `/readyz` (dependencies reachable).
- Optional: Prometheus and Grafana in a compose profile.

### 16.4 Service level objectives

| Metric | Target |
|---|---|
| Command ack, fast path | p95 under 250 ms |
| Command ack, LLM path | p95 under 2.5 s |
| Commit to viewer screen | p95 under 1 s |
| Scoreboard GET (cached) | p95 under 100 ms |
| Lost committed events | 0 |

---

## 17. Milestones

Each milestone has acceptance criteria. Do not start the next one until all pass.

**M0: Skeleton.** Monorepo, TypeScript, lint, CI, compose with Mongo, Redis, Kafka. Every service has `/healthz`.
*Done when:* `docker compose up` brings everything healthy and CI is green.

**M1: Engine.** `packages/engine` and `packages/schemas`, with Cricsheet replay tests.
*Done when:* replaying at least 100 real matches (IPL and internationals) reproduces official innings totals, wickets, and overs exactly. Property tests pass. Undo works.

**M2: Event store and command API.** Scoring API, Mongo event store, idempotency, optimistic concurrency, scorer lease and fencing, outbox writes. Use `InMemoryEventBus` for now.
*Done when:* two concurrent commands cannot both claim the same `seq`, replayed requests are idempotent, and a stale epoch is rejected.

**M3: Real-time pipeline (MVP demo).** Kafka, outbox relay, projector, realtime service, viewer page, button-based scorer UI.
*Done when:* one phone scores and three phones update live in under 1 s, including after a reconnect. **This is the first demo-able milestone.**

**M4: Gateway and load balancing.** Gateway, Nginx, Redis rate limiting, circuit breakers, graceful shutdown, 2+ replicas of gateway, scoring-api, realtime.
*Done when:* killing one replica of each service mid-match causes no lost events and no visible viewer outage, and rate limits return `429` correctly.

**M5: Voice.** Parser service, fast path, LLM path, breaker, concurrency limit, speech input in the PWA, `voice_logs`, eval harness.
*Done when:* eval accuracy is 90% or higher, the LLM-down case falls back to buttons cleanly, and p95 targets in 16.4 hold.

**M6: Offline-first.** IndexedDB queue (B1), shared engine in the browser, sync with idempotency.
*Done when:* a scorer scores a full over in airplane mode, reconnects, and viewers receive exactly those events once, in order.

**M7: Reports.** `match.lifecycle`, report worker, stats from the engine, LLM narrative grounded on stats, DLQ, retry, shareable summary page.
*Done when:* every completed match gets a report, and every number in the narrative matches the engine stats (automated check).

**M8: Hardening and proof.** Metrics, dashboards, k6 load test, chaos checks (kill Kafka, Redis, a node), ADRs, README with an architecture diagram and numbers.
*Done when:* the load test results and failure-mode behavior in 16.1 are documented with real measurements.

---

## 18. Capacity assumptions (design targets, not measured results)

- 1,000 concurrent live matches, 1 ball per ~30 s per match: about 33 committed events/s.
- Up to 200 viewers per match: 200,000 sockets in the worst case, about 6,600 emitted messages/s before coalescing.
- A single Node Socket.IO instance is assumed to hold roughly 10-20k connections. Plan 10-20 realtime instances for the worst case and verify with k6.
- Fast path assumed to cover about 70% of balls. LLM cost scales with the remaining 30% (cacheable).
- Scale triggers: consumer lag growing for 5 min, p95 command latency over target, CPU over 70%.
- Replace these with real numbers from M8.

---

## 19. Key decisions (do not change without an ADR)

1. **Event sourcing in MongoDB.** Replay is cheap (about 250 events per T20 innings), undo and audit come for free, and correctness is testable against Cricsheet.
2. **Synchronous command path, Kafka after commit.** The scorer needs an immediate answer. Kafka decouples everything downstream.
3. **Transactional outbox.** Gives reliable event publishing without distributed transactions.
4. **Parser as its own service.** Isolates LLM latency and failure.
5. **Redis adapter instead of sticky sessions.** Any realtime node can serve any client.
6. **At-least-once plus idempotency over exactly-once.** Simpler and enough.
7. **Single scorer per match (lease plus fencing).** Multi-scorer merging is out of scope.
8. **Engine shared with the browser.** One set of rules for offline and online.

---

## 20. Out of scope

Multi-scorer merging, video streaming, betting or fantasy or any real-money feature, DLS, super overs, native mobile apps, payments, social features.

## 21. Clarifications

1. **Sequence:** `seq` is gapless per match. A command producing several events inserts them in one transaction (`lastSeq+1..n`). Retry once on unique-index conflict.
2. **Undo:** `UNDO` may only target the most recent non-voided scoring event (`BALL`, `BOWLER_SET`, `BATTER_SET`). No redo, no undoing an UNDO. Repeated undos walk backward. Replay recomputes everything after the voided event, so undo across an over boundary works.
3. **Fencing authority:** Mongo is authoritative (`matches.scorerEpoch` and the unique `(matchId, seq)` index). The Redis lease is only a fast-path check and heartbeat signal. If Redis is down, scoring continues on Mongo checks alone.
4. **Epoch rules:** `scorerEpoch` increments only when a different user takes over. Lease expiry alone does not bump it. An offline scorer who reconnects with an unchanged epoch resumes normally.
5. **Offline conflicts (v1):** if the epoch changed while offline, the server rejects the whole queued batch with 409. The client offers discard or export. No merging.
6. **Auth boundary:** the gateway requires JWT only on scorer routes (auth, match creation, commands, scorer claim/heartbeat). Public GETs and socket joins skip it.
7. **Kafka message:** value is the full `EventEnvelope` JSON; headers are `requestId` and `schemaVersion`. Retry and DLQ logic is one shared wrapper in `packages/eventbus`.
8. **Cricsheet scope (M1):** pin a data snapshot date. Validate in stages: 10, then 50, then 100 matches. Skip matches with DLS, super overs, or unsupported penalty runs, and list each skipped match with a reason. Done when 100% of included matches reproduce exactly.
9. **Voice eval protocol:** pin provider and model in config. Freeze `cases.jsonl` and hold out 30% as a test set never used for prompt tuning. Record the first run as `baseline.json`. 90% is a target to revisit after the baseline.
10. **Local scaling:** if `docker compose ps` shows one replica despite `deploy.replicas`, use `--scale`.
11. **Types:** the agent proposes `MatchState` and command schemas in the M1 plan. Wait for approval before coding.