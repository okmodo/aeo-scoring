# Frozen report compatibility fixtures

These are fictional reports for deterministic contract and rendering checks. The `raw` evidence method exercises the live-report rendering guard; it does not claim a real merchant audit occurred.

The v2 examples explicitly enumerate current test IDs and expected statuses, weights and points. `v2-serialized.json` freezes the expected additive presentation metadata independently of the production serializer. `v1-presentation.json` freezes the legacy metadata expected from service serialization. They were constructed from the reviewed versioned rubric and catalog, without calling `serializeReport`; tests compare producer output with these stored expectations.

Existing contract examples and scoring gold files are unchanged. In-memory older report test cases were corrected to use proper criterion membership and redistribution weights because the new validator now rejects previously tolerated impossible combinations. This changes test input validity, not scoring expectations. Independent review must assess any future changes to these expectations and their rationale.

The v2 presentation expectations use business-owner wording for initial page content, product records and option links. This copy revision replaces technical terms such as entity, parse and markup; test IDs, rubric rules, points and statuses are unchanged.
