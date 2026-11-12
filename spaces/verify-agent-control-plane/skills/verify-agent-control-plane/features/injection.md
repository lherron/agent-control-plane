# HRC delivery and reconciliation

## Sub-features

Socket injection boundary, standalone mail delivery, retries and deferral backoff, ACK/cursor behavior, refusal handling, the wake model (wrkq commit waits, HRC lifecycle rings and deadline clocks in place of idle polling, T-12512/T-12549).

Source anchors (repo-relative): packages/hrc-injector-core/src; packages/hrc-mail-injector/src. Exact tracked surface inventory follows; a mapping is not a behavioral assertion.

- Surface: `package:hrc-injector-core`
- Surface: `package:hrc-mail-injector`

## How to get to it

Use package source/README and `bun scripts/discover-acp.ts packages injector`. Installed `hrc-mail-injector --help` is surface inspection only; do not start the injector.

## Driving it

Inspect isolated package integration suites through `just verify`. Delivery, ACK/cursor, retry/backoff, birth/refusal, stall and wake drives are **undriven by design** under the owner constraint (T-11680): no fake-recipient harness, PATH shim, placement-bind engineering or live recipient substitute may be built or used to drive them. T-11920 drove the standalone injector, booting it against a scratch HRC and a scratch ledger. It showed admission, import, tail, boot reconcile and `inspect`. A scratch envelope to a homeless recipient stayed `pending`, because the kicker wakes only seated, placement-bound or unborn-designated targets on its node. That partial drive does not make this map driven.

## Gotchas

No production inbox reads/writes through these drives, no timing or ACK/cursor edits here. Live injector behavioral changes require separate owner ruling and T-11680 delivery proof. Placement stays HRC authority.

## Proven when

Current status: undriven by design (owner constraint, T-11680). The proof is source-only package suites plus T-11920's narrow scratch boot and admission. There is no manual delivery, ACK, cursor, retry, stall or birth proof. Report this map as undriven in every upkeep and never count it as driven. A future proof needs a separate owner ruling. It must then correlate the scratch envelope, reservation, HRC input result and durable ACK, including retry/stall failure cases.
