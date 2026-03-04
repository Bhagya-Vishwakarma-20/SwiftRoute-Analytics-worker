# ⚡ SwiftRoute Analytics Worker

The **analytics microservice** for [SwiftRoute](https://github.com/bhagya888/redirect) — an event-driven consumer that asynchronously processes click events from the redirect API. It listens on a durable RabbitMQ queue, enriches each event, and persists it to PostgreSQL — fully decoupled from the latency-sensitive redirect path.

---

## Architecture Overview

```
  ┌────────────────────────────────────────────────────────────────┐
  │                    Redirect API (upstream)                     │
  │                                                                │
  │   GET /url/:code  →  302 redirect                             │
  │                    →  publishes click event to RabbitMQ        │
  └──────────────────────────────┬─────────────────────────────────┘
                                 │  fire-and-forget publish
                                 ▼
  ┌────────────────────────────────────────────────────────────────┐
  │                    RabbitMQ (AMQP)                             │
  │                                                                │
  │   Queue: click_analytics (durable)                             │
  │   • Survives broker restarts                                   │
  │   • Prefetch = 20 for back-pressure control                   │
  └──────────────────────────────┬─────────────────────────────────┘
                                 │  async consume
                                 ▼
  ┌────────────────────────────────────────────────────────────────┐
  │                  Analytics Worker (this service)               │
  │                                                                │
  │   1. Consume message from queue                                │
  │   2. Parse click payload                                       │
  │      { linkId, ip, userAgent, referrer, timestamp }            │
  │   3. Persist to PostgreSQL via Prisma ORM                      │
  │   4. ACK on success / NACK (no requeue) on failure             │
  └──────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼
  ┌────────────────────────────────────────────────────────────────┐
  │                    PostgreSQL                                  │
  │                                                                │
  │   Click table                                                  │
  │   ├── id (UUID)                                                │
  │   ├── linkId                                                   │
  │   ├── ip                                                       │
  │   ├── country                                                  │
  │   ├── userAgent                                                │
  │   ├── referrer                                                 │
  │   └── timestamp                                                │
  └────────────────────────────────────────────────────────────────┘

  ┌────────────────────────────────────────────────────────────────┐
  │                   Observability Layer                           │
  │                                                                │
  │   New Relic APM  → Background transaction per message          │
  │   NRQL Dashboards → Consume rate, error rate, latency          │
  └────────────────────────────────────────────────────────────────┘
```

---

## Design Decisions

### Async, Non-Blocking Event Processing

- The worker **never sits in the redirect hot-path** — it only consumes from RabbitMQ after the user has already received a `302`
- Each message is processed inside a **New Relic background transaction**, giving full APM visibility without HTTP overhead
- Failed messages are **NACK'd without requeue** to prevent poison-pill loops clogging the queue

### Resilient RabbitMQ Connection

- Built-in **retry-with-backoff** loop — if RabbitMQ isn't ready on boot, the worker retries every 5 seconds until connected
- Connection error and close events are handled with **automatic reconnection logic**
- Queue is declared as **durable** — messages survive broker restarts

### Back-Pressure via Prefetch

- `channel.prefetch(20)` limits the number of unacknowledged messages in flight
- Prevents the worker from being overwhelmed during traffic spikes while keeping throughput high

## Observability — New Relic

Every consumed message is wrapped in a **New Relic background transaction** (`AnalyticsMessageProcessing`), enabling:

- Per-message **throughput** and **response time** tracking
- **Error rate** monitoring with `newrelic.noticeError()`
- Custom **NRQL dashboards** for consume rate and worker health



---

## Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| **Runtime** | Node.js (CommonJS) | Server runtime |
| **Database** | PostgreSQL + Prisma ORM | Click event persistence, type-safe queries |
| **DB Adapter** | `@prisma/adapter-pg` | Direct PG driver — no engine binary needed |
| **Message Queue** | RabbitMQ (amqplib) | Durable queue consumption via AMQP |
| **APM** | New Relic | Background transaction tracing, NRQL dashboards |
| **Config** | dotenv | Environment-based configuration |
| **Containers** | Docker (multi-stage) | Minimal Alpine production image |



---

## Quick Start

### With Docker Compose (recommended — from the main SwiftRoute repo)

```bash
docker compose up -d
```

The analytics worker starts automatically alongside Redis, RabbitMQ, and the redirect API.

### Standalone Docker

```bash
docker build -t analytics-worker .
docker run --name analytics-worker \
  --network my-net \
  -e DATABASE_URL=postgresql://user:pass@postgres:5432/swiftroute \
  -e AMQP_URL=amqp://redirect-rabbitmq \
  -e NEWRELIC_LICENSE=your_license_key \
  analytics-worker
```





## Key Highlights

- **Decoupled microservice** — Deployed, versioned, and scaled independently from the redirect API.
- **Zero impact on redirect latency** — Processes events asynchronously after the user receives a `302`.
- **Durable messaging** — RabbitMQ queue survives broker restarts; no click data is lost in transit.
- **Back-pressure aware** — Prefetch limit prevents overload during traffic spikes.
- **Full APM coverage** — Every message is a traced New Relic background transaction with error capture.
- **Resilient boot** — Retries RabbitMQ connection indefinitely on startup — handles Docker service ordering gracefully.