export type SeededWrkqFixture = {
  dbPath: string
  close(): void
  cleanup(): void
  seed: {
    bootstrapActorUuid: string
    projectUuid: string
    projectId: string
    projectSlug: string
    secondaryProjectUuid: string
    secondaryProjectId: string
    secondaryProjectSlug: string
  }
}
export declare function createSeededWrkqDb(): SeededWrkqFixture
export declare function withSeededWrkqDb<T>(run: (fixture: SeededWrkqFixture) => T): T
//# sourceMappingURL=seed-wrkq-db.d.ts.map
