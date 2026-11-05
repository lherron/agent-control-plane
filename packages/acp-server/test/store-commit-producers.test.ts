import { expect, test } from 'bun:test'
import { openSqliteAdminStore } from 'acp-admin-store'
import { openInterfaceStore } from 'acp-interface-store'
import { openSqliteJobsStore } from 'acp-jobs-store'
import { openAcpStateStore } from 'acp-state-store'
import { openCoordinationStore } from 'coordination-substrate'

test('every daemon-owned store instruments prepared writes and outer commit by default', () => {
  let commits = 0
  const onCommit = () => {
    commits++
  }
  const stores = [
    openSqliteAdminStore({ dbPath: ':memory:', onCommit }),
    openInterfaceStore({ dbPath: ':memory:', onCommit }),
    openSqliteJobsStore({ dbPath: ':memory:', onCommit }),
    openAcpStateStore({ dbPath: ':memory:', onCommit }),
    openCoordinationStore(':memory:', onCommit),
  ]
  expect(commits).toBe(0)
  try {
    for (const store of stores) {
      store.sqlite.exec('CREATE TABLE notification_test(id INTEGER PRIMARY KEY)')
      const before = commits
      const insert = store.sqlite.prepare('INSERT INTO notification_test VALUES (?)')
      store.sqlite.transaction(() => {
        insert.run(1)
        expect(commits).toBe(before)
      })()
      expect(commits).toBe(before + 1)
      expect(() =>
        store.sqlite.transaction(() => {
          insert.run(2)
          throw Error('rollback')
        })()
      ).toThrow()
      expect(commits).toBe(before + 1)
    }
  } finally {
    for (const store of stores) store.close()
  }
})
