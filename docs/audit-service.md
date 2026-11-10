# Audit service backend

The current backend pipeline, limits, ownership and release boundaries are specified in [complete-scoring-engine.md](complete-scoring-engine.md). The versioned response types and frozen examples are in [contracts/v1](../contracts/v1/README.md).

The public Worker uses the existing isolated public-only egress transport, D1 audit storage, HMAC client quotas and a background audit lease. Robots policy never gates product retrieval. Reports preserve Structure /40, Content /60, evidence, assignable fixes and conditional recovery. Missing applicable evidence withholds the final score; retrieval failure returns no report or numerical score.

Frontend presentation, integration adapters and live browser CORS configuration have separate ownership. Preserve the existing live CORS wrapper during any separately authorized deployment; it is not represented by this backend change.
