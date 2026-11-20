# Automatic retained HTML preprocessing

This change builds on PR #47's direct cleaned-HTML assessment path. It changes backend preparation and private storage only. No production deployment, frontend change, model retry, external integration, allowance increase or CPU-limit change is included.

## Stored data and execution order

Capture stores the original browser response in the existing private `/html` and `/snapshot` objects. On the assessment invocation, the workflow reads and verifies that original, applies deterministic native HTMLRewriter preprocessing, saves one `/prepared` JSON artifact, then reads and verifies that artifact before extracting or retaining assessment inputs. It returns those cleaned bytes as both `rawHtml` and `browser.renderedHtml` to the AI path. The original objects and their hashes remain unchanged.

The artifact contains `version`, `html`, and `preprocessing` metadata. Metadata records preprocessing version `simplified-html-v1`, representation `cleaned_rendered_html`, original R2 object reference/hash/bytes, cleaned hash/bytes, preparation time, original expiry, operations and removal counts. The workflow binds these fields to the verified original and verifies cleaned bytes after readback. R2 writes/reads reserve existing included allowances before work; uncertain failed operations retain their holds. D1 tracks `prepared_state`, `prepared_size` and `prepared_hash`. Inputs use version 2 and are bound to the exact prepared metadata.

Workflow/cache identity is `browser-content-v3`. The original capture representation remains `browser-content-v2`; cleaning is recorded separately rather than relabeling the original response. Old inputs without prepared metadata are rejected instead of treated as cleaned. Migration `0010-prepared-html.sql` is required before an eventual authorized backend rollout; it is not applied remotely by this PR.

## Reduction and preservation

The cleaner removes non-JSON scripts, style elements, stylesheet links, comments, ordinary presentation attributes, recognized event handlers and SVG geometry/plain paint. It preserves JSON-LD and other JSON script bodies, text/headings/tables, links, form values and selection state, image descriptions, accessibility labels, IDs and references. It retains common hidden/context class or style markers and URL references. It does not execute JavaScript, follow links, determine computed visibility or invent product categories/attributes. No 300-item limit determines cleaned-source coverage.

Cleaning does remove some contextual class/style information; class-based context preservation is heuristic. The complete original capture remains available. PR #47's `visibility=unknown`, `absenceComplete=false`, initial-document isolation and exact-quotation validation still apply. Cleaned content cannot establish exhaustive absence, conditional exclusions or complete claim inventories merely because its bytes were fully inspected.

## Bounds, retries and retention

Input is at most 8 MiB with strict UTF-8. Cleaned output is at most 4 MiB minus 64 KiB to leave assessment-source headroom. Prepared JSON is capped at 8 MiB; unusually escape-heavy HTML can fail that bound even when its HTML fits. Limits fail explicitly without truncation. Native serialization can expand small documents, so source size and output size are independently verified.

A completed prepared artifact is reused; parsing inputs resumes from its durable readback. A concurrent pending publisher is not treated as ready. If it finishes, a retry can reuse it. An interrupted pending write is not automatically reset or overwritten: it remains unavailable until expiry/cleanup. This is not a new automatic job-resumption system.

Raw, prepared and assessment artifacts share the original 24-hour expiry; preparation never extends it. Existing cleanup deletes the prepared object too, including indexed partial writes. A successful capture followed by preparation/readback failure returns `Assessment incomplete`, no numerical score and no AI call. Retrieval failure remains `Unable to assess`.

## Verification

Frozen native fixtures cover semantic/JSON preservation, SVG labels/references, hidden/context markers, custom attributes, malformed nesting, invalid UTF-8, more than 300 blocks, output overflow and control-character stress. Real SQLite/in-memory R2 integration tests cover durable-readback ordering, reuse, tampering, expired reads, rejected oversized JSON, concurrent publication and cleanup. The named browser-build check installs the backend runtime and runs the native preprocessing tests; they do not silently skip.

A fresh-agent exit test uses only exported synthetic retained state and clean task files at the prepared-ready / inputs-absent boundary. It must continue input preparation without retrieval or preprocessing, and reject tampered or expired artifacts. Exact observations and replay commands are recorded with the evaluation evidence.

The private saved Faherty capture replay yielded 428,593 bytes from 1,353,581 bytes. The 230.1 ms local wall-time observation included runtime startup and serialization; it is not a Cloudflare CPU or peak-memory measurement. New native tests use production's compatibility date 2026-11-05. No live AI/browser request or Cloudflare write is part of this change. Production remains on its existing release, with 60% ceilings and 1,000 ms CPU cap unchanged. The previously observed model response deadline remains a separate unresolved issue.
