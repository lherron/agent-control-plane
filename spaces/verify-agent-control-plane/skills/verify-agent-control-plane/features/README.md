# ACP feature verification map

Start at [the skill](../SKILL.md). These maps enumerate source capability families and safe drive boundaries. All listed surfaces are structurally mapped; runtime status is scoped by each map’s Proven when paragraph and the evidence from the current run. No map claims blanket installed correctness.

- [CLI and administration](cli-admin.md)
- [Workflow, effects and jobs](workflow-jobs.md)
- [Interfaces and gateways](interfaces.md)
- [C2 mobile cards](c2-cards.md)
- [C2 threads](c2-threads.md)
- [Mobile Jobhunt forwarding](mobile-jobhunt.md)
- [Stores and projections](stores-projections.md)
- [Capabilities and learning](capabilities-learning.md)
- [Hooks, launchd, deployment and gates](operations.md)

Retired maps. ACP no longer has an injection map. The TypeScript mail injector packages were deleted in 7930809 (T-13419), and the delegated-session reconciler with them in 3afd22b. Mail delivery now lives in praesidium-kernel `modules/mail-delivery`. Delivery, ACK/cursor, retry/backoff, birth/refusal, stall and reconciler behaviour therefore stay undriven by design under the owner ruling (T-11917, constraint 2). Proof needs T-11680 live delivery on change, and it belongs to that module's owner. An ACP upkeep counts only the maps above, never drives or counts delivery, and keeps T-11920's narrow injector scratch boot as historical evidence only.

Refresh inventory with `bun scripts/verify-feature-map.ts --inventory`. Review additions against source, choose a map, and add an exact Surface entry. Do not silently regenerate to hide removed capabilities. The checker detects missing/stale/duplicate entries, unindexed maps, empty required sections and broken local links. It inventories package names, Commander command paths with long flags, registered HTTP method/path pairs, tracked lifecycle/hook/workflow files and all just recipes. Package exports, dynamic routes, non-ACP binary commands and internal subfeatures require human review and existing public-surface guards; this inventory is not exhaustive semantic coverage.
