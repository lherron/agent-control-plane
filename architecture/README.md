# agent-control-plane Durable Architecture Records

Active YAML records under `architecture/records/` are this repository's
normative architecture law. ADRs and generated projections are provenance and
readable indexes; docs, tasks, chats, and comments cannot override an active
record.

Run `just architecture-records` to validate the ledger. Run
`just architecture-records --write` after changing records to regenerate
`INVARIANTS.md`, `RISKS.md`, and `index.jsonl`. `just verify` includes this
gate.
