# Behavior-read documentation fixtures

- `heuristic-learning/implementation.md` preserves the historical milestone log from wrkq attachment ATT-00366 on T-11892. Its documentation-sync test was retired under §8 in T-11957; the fixture remains historical evidence.
- `mobile/gateway-ios-smoke.md` preserves the exact historical smoke report consumed by `scripts/check-public-surface.ts`; its extracted public references remain gated. Original: wrkq attachment ATT-00369 on T-11892.

The mobile fixture remains a test input because the public-surface gate reads it. New smoke reports and status output belong in the originating wrkq task's `artifact_dir`, not here.
