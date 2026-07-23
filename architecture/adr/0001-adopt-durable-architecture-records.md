# ADR 0001: Adopt Durable Architecture Records

Status: Accepted
Date: 2026-07-23

agent-control-plane adopts active records under `architecture/records/` as its
repo-local durable architecture authority. The initial ledger records the
schedule owner-set execution invariant and Lance's accepted medium risk that a
healthy peer does not make up occurrences missed by a down owner.

The ledger is structural, generated projections are read-only, and
`just architecture-records` is part of `just verify`.
