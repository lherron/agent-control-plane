# Behavior-read documentation fixtures

- `heuristic-learning/implementation.md` preserves the exact historical milestone log consumed by `tests/conformance/acp-workflow/heuristic-learning-spec.test.ts`. Original: wrkq attachment ATT-00366 on T-11892 (historical work-output preservation).
- `mobile/gateway-ios-smoke.md` preserves the exact historical smoke report consumed by `scripts/check-public-surface.ts`; its extracted public references remain gated. Original: wrkq attachment ATT-00369 on T-11892.

These files remain test inputs because existing gates read them. New smoke reports and status output belong in the originating wrkq task's `artifact_dir`, not here.
