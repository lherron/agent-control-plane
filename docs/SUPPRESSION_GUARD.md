# Suppression Guard

ACP treats lint, typecheck, and test suppressions as visible, bounded cost.
`scripts/check-suppressions.ts` runs first in `just check`, and so in
`just verify`; `just check-suppressions` runs it alone. It scans JavaScript and
TypeScript source files for selected suppression forms and fails on unreviewed,
blanket, stale, or over-budget entries.

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
- every baseline row's review column must carry a reviewed marker:

```text
SUPPRESSION-REVIEWED[T-xxxxx]: rationale for accepting the suppression cost
```

A baseline row is tab-separated `kind`, `count`, `file`, the suppression's
comment or line text, and the review. A row is matched by kind, file and
whitespace-normalized text, not by line number, and its count is the number of
identical suppressions that file may hold.

When a reviewed change intentionally adds suppression cost, add or update its
baseline row in the same change. A marker at the suppression site does not
replace the row; it only changes the guard's failure message. Removing a
suppression must also remove or decrement its baseline row, or the guard fails
on the stale entry.
