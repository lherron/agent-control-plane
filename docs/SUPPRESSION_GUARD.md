# Suppression Guard

ACP treats lint, typecheck, and test suppressions as visible, bounded cost.
`just verify` runs `just check-suppressions`, which scans source files for
selected suppression forms and fails on unreviewed, blanket, stale, or
over-budget entries.

Selected forms:

- `biome-ignore`
- `eslint-disable`, `eslint-disable-next-line`, `eslint-disable-line`
- `@ts-expect-error`, `@ts-ignore`, `@ts-nocheck`
- `test.skip`, `it.skip`, `describe.skip`
- `test.only`, `it.only`, `describe.only`

Policy:

- blanket suppressions are forbidden;
- lint suppressions must name a narrow rule where the tool supports rule names;
- every accepted suppression must be recorded in `scripts/suppression-baseline.tsv`;
- every baseline entry must carry a reviewed marker:

```ts
// SUPPRESSION-REVIEWED[T-xxxxx]: rationale for accepting the suppression cost
```

When a reviewed change intentionally adds suppression cost, add the visible
marker at the suppression site or in the baseline rationale and update the
baseline in the same change. Removing a suppression must also remove its stale
baseline row.
