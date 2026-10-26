# HRC delivery and reconciliation

## Sub-features

Socket injection boundary, standalone mail delivery, retries, ACK/cursor behavior, delegated reserve/start/stall reconciliation.

Source anchors (repo-relative): packages/hrc-injector-core/src; packages/hrc-mail-injector/src; packages/acp-reconciler/src. Exact tracked surface inventory follows; a mapping is not a behavioral assertion.

- Surface: `package:acp-reconciler`
- Surface: `package:hrc-injector-core`
- Surface: `package:hrc-mail-injector`

## How to get to it

Use package source/README and `bun scripts/discover-acp.ts packages injector`. Installed `hrc-mail-injector --help` is surface inspection only; do not start the injector.

## Driving it

Inspect isolated package integration suites through `just verify`. A manual delivery drive requires a dedicated scratch wrkq ledger, scratch HRC socket, explicit principal/project and task recipient, disabled live mail reads, and owned lifecycle. If any override is absent, block the drive and record which boundary is missing.

## Gotchas

No production inbox reads/writes through these drives, no timing or ACK/cursor edits here. Live injector behavioral changes require separate owner ruling and T-11680 delivery proof. Reconciler placement stays HRC authority.

## Proven when

Current status: source-only tests, no manual mail/ACK/reconciler proof. A future proof must correlate scratch envelope, reservation, HRC input result and durable ACK with retry/stall failure cases.
