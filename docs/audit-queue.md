# Queued audit checkpoints

Queue mode moves capture, preparation and scoring out of the HTTP response lifecycle. The public API still returns a pending assessment and reads report status from D1. It confirms the first queue write before returning `202`. Cached reports require no new message. The 1,000 ms Worker CPU cap, per-model timeout, 24-hour audit data lifetime, and existing usage ceilings remain in effect. Each delivery processes at most one provider call, while Queue consumers can wait up to 15 minutes of wall time. [Queue limits](https://developers.cloudflare.com/queues/platform/limits/)

A message contains an audit UUID and sequence. D1 owns the phase, deadline, and lease. A completed phase commits its successor state before sending. The predecessor is acknowledged after the successor send and its D1 confirmation. An interruption during that handoff leaves a recoverable dispatching row. Redelivery can dispatch that successor, while the D1 sequence and claim prevent simultaneous work or repeated completed provider calls. An interrupted model request with uncertain usage keeps its hold and is not replayed. [At-least-once delivery](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)

After the configured delivery retries, a dead-letter delivery attempts terminal publication without calling Browser or Granite. A verified capture enables an incomplete report. Existing verified rubric facts can contribute points and evidence. Where no verified capture is available, the audit reports a retrieval or assessment failure. The audit status endpoint shows a terminal timeout at the 20-minute queue deadline if the database cannot publish a terminal report sooner. It never advances work. Hourly maintenance still only cleans up and does not discover or start audits.

## Activation checklist

Apply migrations `0012-audit-queue.sql` and `0013-audit-queue-allowance.sql` to the dedicated project D1 database before activation. Queue mode is off until the project Worker receives `AUDIT_QUEUE_MODE=enabled` and a producer binding named `AUDIT_QUEUE`. Configure the same project Worker's queue handler as consumer of both project queues.

| Setting | Main queue | Dead-letter queue |
| --- | --- | --- |
| Queue name | `aeo-audit-checkpoints` | `aeo-audit-checkpoints-dead` |
| Maximum batch size | 1 | 1 |
| Maximum retries | 2 | 2 |
| Message retention | 24 hours or less | 24 hours or less |
| Dead-letter target | `aeo-audit-checkpoints-dead` | None |

The application uses a retry delay slightly beyond its 120-second lease. Keep retention and retry settings aligned with the allowance guard. Confirm the queues have only the intended project consumer and that existing CPU and billing bindings are preserved. Verify the usage token can query account-wide `billableOperations` for the pinned billing cycle before accepting production traffic. When switching off queue mode, stop new submissions and drain or resolve the active queue messages before changing the flag. [Consumer settings](https://developers.cloudflare.com/queues/configuration/batching-retries/) · [Queue usage metrics](https://developers.cloudflare.com/queues/observability/metrics/)

Workers Paid includes 1 million monthly Queue operations. The guard uses a 600,000-operation operating ceiling for the account and reserves 10 operations before every send. The reservation covers the configured main and dead-letter attempts. Account estimates plus bounded daily reservation buckets can conservatively count some activity twice. There is no release of a send reservation on an ambiguous response. Account analytics can lag and duplicate delivery can occur, so this is an application guard. [Queue pricing](https://developers.cloudflare.com/queues/platform/pricing/)

## Verification

The offline integration test verifies that an accepted audit completes its queue workflow after the client closes. Five fixture calls span 35 seconds of simulated time. It also checks duplicate delivery, initial dispatch failure and a dead-letter partial report. The service integration uses SQLite and simulated Queue/R2/Browser/inference transports. A separately authorized staging run is needed to measure hosted CPU, delivery and billing behavior with a real Faherty audit.
