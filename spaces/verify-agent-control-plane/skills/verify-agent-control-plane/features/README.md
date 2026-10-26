# ACP feature verification map

Start at [the skill](../SKILL.md). These maps enumerate source capability families and safe drive boundaries. All listed surfaces are structurally mapped; runtime status is scoped by each map’s Proven when paragraph and the evidence from the current run. No map claims blanket installed correctness.

- [CLI and administration](cli-admin.md)
- [Workflow, effects and jobs](workflow-jobs.md)
- [Interfaces and gateways](interfaces.md)
- [HRC delivery and reconciliation](injection.md)
- [Stores and projections](stores-projections.md)
- [Capabilities and learning](capabilities-learning.md)
- [Hooks, launchd, deployment and gates](operations.md)

Refresh inventory with `bun scripts/verify-feature-map.ts --inventory`. Review additions against source, choose a map, and add an exact Surface entry. Do not silently regenerate to hide removed capabilities. The checker detects missing/stale/duplicate entries, unindexed maps, empty required sections and broken local links. It inventories package names, Commander command paths with long flags, registered HTTP method/path pairs, tracked lifecycle/hook/workflow files and all just recipes. Package exports, dynamic routes, non-ACP binary commands and internal subfeatures require human review and existing public-surface guards; this inventory is not exhaustive semantic coverage.
