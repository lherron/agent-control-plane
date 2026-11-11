/** Lance's thread writes, with wrkq replay/fences and explicit HRC partial outcomes. */
import { existsSync } from 'node:fs'
import { type WorkClient, WorkRpcError } from '@wrkq/client'
import { HrcDomainError } from 'hrc-core'
import type { ResolvedAcpServerDeps } from '../deps.js'
import { archiveThreadSeat, startThreadSeat, threadSeats, writeThreadWork } from './thread-hrc.js'

export class ThreadRequestError extends Error {}
export type Thread = Awaited<ReturnType<WorkClient['wrkq']['task']['show']>>
const LANCE = 'agent:lance'
const TERMINAL = new Set(['completed', 'archived', 'cancelled', 'deleted'])
export function reason(error: unknown): string {
  if (error instanceof HrcDomainError) return error.code
  if (error instanceof WorkRpcError) return error.domainCode ?? 'owner_protocol'
  return String(error)
}
export function knownRefusal(error: unknown): boolean {
  return (
    error instanceof HrcDomainError ||
    (error instanceof WorkRpcError && error.domainCode !== undefined)
  )
}
export function ownScope(scope: string, id: string): boolean {
  return (
    /^W-\d+$/.test(id) &&
    /^agent:[^:]+:project:[^:]+:task:W-\d+$/.test(scope) &&
    scope.endsWith(`:task:${id}`)
  )
}
export async function seatRecord(client: WorkClient, id: string): Promise<string | null> {
  try {
    const { ext } = await client.wrkq.ext.show({
      subject: { task: id },
      ns: 'acp',
      kind: 'thread',
      id: 'seat',
    })
    const scope = ext.body['scopeRef']
    return typeof scope === 'string' && ownScope(scope, id) ? scope : null
  } catch (error) {
    if (error instanceof WorkRpcError && /NOT_FOUND/.test(error.domainCode ?? '')) return null
    throw error
  }
}
export async function readThread(client: WorkClient, id: string): Promise<Thread> {
  const thread = await client.wrkq.task.show({ task: id })
  if (thread.kind !== 'workstream') throw new ThreadRequestError('not_a_thread')
  return thread
}
export async function allThreads(client: WorkClient): Promise<Thread[]> {
  const rows: Thread[] = []
  let cursor: string | undefined
  do {
    const page = await client.wrkq.task.list({
      kind: 'workstream',
      limit: 200,
      ...(cursor ? { cursor } : {}),
    })
    rows.push(...page.items)
    cursor = page.nextCursor
  } while (cursor)
  return rows
}
export function threadLine(id: string, project: string): string {
  return `This seat is Lance's thread ${id}. Read it with prae workstream get ${id}. Once you know what it is about, retitle it with prae workstream update. When Lance rules something here that binds the project, mail mable@${project}:primary yourself, reply-required, at the time.`
}
export type ThreadsDeps = Pick<
  ResolvedAcpServerDeps,
  'adminStore' | 'hrcClient' | 'workClientForPrincipal'
>
export function createThreads(deps: ThreadsDeps) {
  const hrc = deps.hrcClient
  async function client(): Promise<WorkClient> {
    if (!deps.workClientForPrincipal) throw new Error('human_work_client_unavailable')
    return deps.workClientForPrincipal(LANCE)
  }
  function host() {
    if (!hrc) throw new Error('hrc_unavailable')
    return hrc
  }
  async function read(id: string) {
    const work = await client()
    const thread = await readThread(work, id)
    return { ...thread, note: thread.description, seatScopeRef: await seatRecord(work, id) }
  }
  async function localProject(projectId: string): Promise<boolean> {
    const project = deps.adminStore.projects.get(projectId)
    const root = project?.rootDir ?? project?.homeDir
    if (!root || !existsSync(root.replace(/^~(?=\/)/, process.env['HOME'] ?? ''))) return false
    const location = await host().locateScope(`agent:mable:project:${projectId}:task:primary`)
    return (
      location.authority.state !== 'unknown' &&
      (location.authority.state !== 'bound' || location.authority.isLocal)
    )
  }
  async function preflightSeat(scope: string, id?: string) {
    if (!/^agent:[^:]+:project:[^:]+:task:[^:]+$/.test(scope) || /:task:W-\d+$/.test(scope))
      throw new ThreadRequestError('bookmark_requires_standing_seat')
    const seat = (await threadSeats(host(), scope, true))[0]
    if (!seat || (seat.status !== 'active' && seat.disposition !== 'parked'))
      throw new ThreadRequestError('seat_unavailable')
    if (seat.work?.kind === 'workstream' && seat.work.workstreamId !== id) {
      const other = await readThread(await client(), seat.work.workstreamId)
      if (!TERMINAL.has(other.state)) return { conflict: other }
    }
    return { seat }
  }
  async function mail(
    work: WorkClient,
    id: string,
    scope: string,
    text: string,
    key: string,
    note = false
  ) {
    // room.say has a collision guard, not replay. Read the durable log before retrying mail.
    try {
      const log = await work.wrkq.room.logView({ room: id, limit: 200 })
      if (log.items.some((item) => item.idempotencyKey === key)) return
    } catch (error) {
      if (!(error instanceof WorkRpcError) || !/NOT_FOUND/.test(error.domainCode ?? '')) throw error
    }
    await work.wrkq.room.say({
      ref: id,
      to: [scope],
      body: text,
      ...(note ? { note: true } : { fyi: true }),
      principalRef: LANCE,
      idempotencyKey: key,
    })
  }
  async function projectFor(thread: Thread, scope?: string | null): Promise<string> {
    if (scope) return scope.split(':')[3] ?? 'c2'
    const work = await client()
    const page = await work.wrkq.project.listView({ limit: 500 })
    const project = page.items.find(
      (p) => p.id === thread.covers?.container || p.slug === thread.covers?.container
    )
    if (!project) throw new ThreadRequestError('covered_project_missing')
    return project.slug
  }
  async function start(thread: Thread, scope: string, requestId: string) {
    const outcomes: Record<string, unknown> = {
      created: true,
      threadId: thread.id,
      seatScopeRef: scope,
    }
    try {
      await startThreadSeat(host(), scope, requestId)
      outcomes['started'] = true
    } catch (error) {
      return {
        ...outcomes,
        ok: false,
        outcome: knownRefusal(error) ? 'start_failed' : 'unknown_outcome',
        reason: reason(error),
      }
    }
    try {
      await writeThreadWork(host(), scope, { kind: 'workstream', workstreamId: thread.id }, 1)
    } catch (error) {
      outcomes['work_refused'] = { reason: reason(error) }
    }
    try {
      const sent = await host().steer({
        target: `${scope}/lane:main`,
        body: `${threadLine(thread.id, await projectFor(thread, scope))}\n\n${thread.description}`,
        origin: { principalRef: LANCE },
        idempotencyKey: `${requestId}:prompt`,
      })
      const receipt = sent as Record<string, unknown>
      if (typeof receipt['runId'] !== 'string')
        return {
          ...outcomes,
          ok: false,
          outcome: 'prompt_not_sent',
          reason: receipt['admission'] === 'rejected' ? receipt['reason'] : 'unknown_outcome',
          receipt,
        }
      outcomes['receipt'] = sent
    } catch (error) {
      return {
        ...outcomes,
        ok: false,
        outcome: 'prompt_not_sent',
        reason: reason(error),
        delivery: knownRefusal(error) ? 'not_submitted' : 'unknown_outcome',
      }
    }
    return {
      ...outcomes,
      ok: !outcomes['work_refused'],
      outcome: outcomes['work_refused'] ? 'work_refused' : 'created',
    }
  }
  return {
    client,
    read,
    async options(project?: string) {
      const agents = deps.adminStore.agents.list().filter((a) => a.status === 'active')
      const projects = []
      for (const p of deps.adminStore.projects.list()) {
        if (!(await localProject(p.projectId))) continue
        projects.push(p)
      }
      const chosen = projects.find((p) => p.projectId === project)
      const defaultAgent = chosen?.defaultAgentId ?? 'mable'
      const seats = (await threadSeats(host(), undefined, true)).filter(
        (s) =>
          !/:task:W-\d+$/.test(s.scopeRef) && (s.status === 'active' || s.disposition === 'parked')
      )
      const threads = await allThreads(await client())
      return {
        ok: true,
        agents,
        projects,
        defaultAgent,
        seats: seats
          .filter(
            (s) =>
              s.work?.kind !== 'workstream' ||
              !threads.some(
                (t) =>
                  s.work?.kind === 'workstream' &&
                  t.id === s.work.workstreamId &&
                  !TERMINAL.has(t.state)
              )
          )
          .map((s) => ({
            scopeRef: s.scopeRef,
            agent: s.scopeRef.split(':')[1],
            project: s.scopeRef.split(':')[3],
            status: s.status,
            disposition: s.disposition,
            work: s.work,
          })),
      }
    },
    async create(body: {
      requestId: string
      project?: string
      agent?: string
      prompt?: string
      title?: string
      seat?: string | null
    }) {
      const work = await client()
      const own = body.prompt !== undefined
      const project = body.seat ? body.seat.split(':')[3] : body.project
      if (!project) throw new ThreadRequestError('project_required')
      if (!body.seat && !(await localProject(project)))
        throw new ThreadRequestError('project_not_local')
      if (own && (!body.agent || deps.adminStore.agents.get(body.agent)?.status !== 'active'))
        throw new ThreadRequestError('agent_required')
      const title = own
        ? body.prompt?.trim().split(/\s+/).slice(0, 10).join(' ').slice(0, 100)
        : body.title?.trim()
      if (!title) throw new ThreadRequestError('title_or_prompt_required')
      // Lossless base36 encoding keeps the complete submit identity inside wrkq's slug limit.
      const submitSlug = BigInt(`0x${Buffer.from(body.requestId).toString('hex')}`).toString(36)
      const slug = `${
        title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 40) || 'thread'
      }-${submitSlug}`
      if (own && body.seat) throw new ThreadRequestError('own_seat_and_bookmark_are_exclusive')
      let existingId: string | undefined
      if (body.seat) {
        try {
          existingId = (await work.wrkq.task.show({ task: `c2/threads/${slug}` })).id
        } catch (error) {
          if (!(error instanceof WorkRpcError) || !/NOT_FOUND/.test(error.domainCode ?? ''))
            throw error
        }
      }
      let newWorkEtag: number | undefined
      if (body.seat) {
        const check = await preflightSeat(body.seat, existingId)
        newWorkEtag = check.seat?.workEtag
        if (check.conflict)
          return {
            ok: false,
            outcome: 'seat_refused',
            reason: 'seat_on_open_thread',
            thread: check.conflict,
          }
      }
      const projects = await work.wrkq.project.listView({ limit: 500 })
      const covered = projects.items.find((p) => p.slug === project)
      if (!covered) throw new ThreadRequestError('project_unknown')
      const thread = await work.wrkq.task.create({
        path: `c2/threads/${slug}`,
        title,
        description: body.prompt ?? '',
        kind: 'workstream',
        state: 'open',
        assigneePrincipalRef: LANCE,
        covers: { container: covered.id },
        principalRef: LANCE,
        idempotencyKey: body.requestId,
      })
      if (own) {
        const scope = `agent:${body.agent}:project:${project}:task:${thread.id}`
        try {
          const existing = await seatRecord(work, thread.id)
          if (existing !== scope)
            await work.wrkq.ext.put({
              subject: { task: thread.id },
              ns: 'acp',
              kind: 'thread',
              id: 'seat',
              body: { scopeRef: scope },
              ifMatch: 0,
              principalRef: LANCE,
            })
        } catch (error) {
          return {
            ok: false,
            created: true,
            threadId: thread.id,
            outcome: 'seat_record_refused',
            reason: reason(error),
          }
        }
        return start(thread, scope, body.requestId)
      }
      if (body.seat) {
        try {
          await writeThreadWork(
            host(),
            body.seat,
            { kind: 'workstream', workstreamId: thread.id },
            newWorkEtag
          )
          await mail(
            work,
            thread.id,
            body.seat,
            `Lance put this seat on thread ${thread.id}: ${title}.`,
            `${body.requestId}:bind`
          )
        } catch (error) {
          return {
            ok: false,
            created: true,
            threadId: thread.id,
            outcome: 'seat_refused',
            reason: reason(error),
          }
        }
      }
      return { ok: true, created: true, outcome: 'created', threadId: thread.id }
    },
    async edit(
      id: string,
      body: {
        requestId: string
        expectEtag: number
        title?: string
        note?: string
        seat?: string | null
      }
    ) {
      const work = await client()
      await readThread(work, id)
      const own = await seatRecord(work, id)
      if (own && body.seat !== undefined) throw new ThreadRequestError('own_seat_cannot_change')
      let newWorkEtag: number | undefined
      if (body.seat) {
        const check = await preflightSeat(body.seat, id)
        newWorkEtag = check.seat?.workEtag
        if (check.conflict)
          return {
            ok: false,
            outcome: 'seat_refused',
            reason: 'seat_on_open_thread',
            thread: check.conflict,
          }
      }
      try {
        await work.wrkq.task.update({
          task: id,
          actor: LANCE,
          expectEtag: body.expectEtag,
          idempotencyKey: body.requestId,
          patch: {
            ...(body.title !== undefined ? { title: body.title } : {}),
            ...(body.note !== undefined ? { description: body.note } : {}),
          },
        })
      } catch (error) {
        if (error instanceof WorkRpcError && /CONFLICT/.test(error.domainCode ?? ''))
          return { ok: false, outcome: 'conflict', current: await read(id) }
        throw error
      }
      if (body.seat !== undefined) {
        try {
          for (const seat of await threadSeats(host(), undefined, true)) {
            if (
              seat.work?.kind !== 'workstream' ||
              seat.work.workstreamId !== id ||
              seat.scopeRef === body.seat
            )
              continue
            await writeThreadWork(host(), seat.scopeRef, { kind: 'none' }, seat.workEtag)
            await mail(
              work,
              id,
              seat.scopeRef,
              `Lance took this seat off thread ${id}.`,
              `${body.requestId}:unbind:${seat.scopeRef}`
            )
          }
          if (body.seat) {
            await writeThreadWork(
              host(),
              body.seat,
              { kind: 'workstream', workstreamId: id },
              newWorkEtag
            )
            await mail(
              work,
              id,
              body.seat,
              `Lance put this seat on thread ${id}.`,
              `${body.requestId}:bind`
            )
          }
        } catch (error) {
          return {
            ok: false,
            updated: true,
            outcome: 'seat_refused',
            reason: reason(error),
            thread: await read(id),
          }
        }
      }
      return { ok: true, outcome: 'updated', thread: await read(id) }
    },
    async open(id: string, requestId: string) {
      const work = await client()
      const thread = await readThread(work, id)
      const scope = await seatRecord(work, id)
      if (!scope) return { ok: false, outcome: 'seat_refused', reason: 'no_own_seat' }
      if (TERMINAL.has(thread.state))
        return { ok: false, outcome: 'seat_refused', reason: 'thread_closed' }
      const seat = (await threadSeats(host(), scope))[0]
      if (seat?.status === 'active' && seat.runtimeId && seat.runtimeStatus)
        return { ok: true, outcome: 'already_running', seatScopeRef: scope }
      const history = await host().listRuntimes({ all: true, scope })
      const everRan =
        history.some((r) => r.scopeRef === scope && r.laneRef === 'main') ||
        Boolean(seat?.continuation)
      if (!everRan) return start(thread, scope, requestId)
      try {
        if (!host().resumeContinuation) throw new Error('resume_unavailable')
        await host().resumeContinuation?.({ sessionRef: `${scope}/lane:main` })
        return { ok: true, outcome: 'resumed', seatScopeRef: scope }
      } catch (error) {
        return {
          ok: false,
          outcome: knownRefusal(error) ? 'seat_refused' : 'unknown_outcome',
          reason: reason(error),
          seatScopeRef: scope,
        }
      }
    },
    async close(id: string, body: { requestId: string; expectEtag: number; outcome?: string }) {
      const work = await client()
      const thread = await readThread(work, id)
      try {
        await work.wrkq.task.update({
          task: id,
          actor: LANCE,
          expectEtag: body.expectEtag,
          idempotencyKey: body.requestId,
          patch: {
            state: 'completed',
            ...(body.outcome !== undefined ? { outcome: body.outcome } : {}),
          },
        })
      } catch (error) {
        if (error instanceof WorkRpcError && /CONFLICT/.test(error.domainCode ?? ''))
          return { ok: false, outcome: 'conflict', current: await read(id) }
        throw error
      }
      const scope = await seatRecord(work, id)
      const errors: string[] = []
      if (scope) {
        try {
          const seat = (await threadSeats(host(), scope))[0]
          if (seat) await archiveThreadSeat(host(), seat, `Thread ${id} closed`)
        } catch (error) {
          errors.push(reason(error))
        }
        try {
          await mail(
            work,
            id,
            `mable@${await projectFor(thread, scope)}:primary`,
            `Lance closed thread ${id}: ${thread.title}. Outcome: ${body.outcome ?? thread.outcome ?? ''}`,
            `${body.requestId}:close-note`,
            true
          )
        } catch (error) {
          errors.push(reason(error))
        }
      } else {
        try {
          for (const seat of await threadSeats(host(), undefined, true)) {
            if (seat.work?.kind !== 'workstream' || seat.work.workstreamId !== id) continue
            try {
              await writeThreadWork(host(), seat.scopeRef, { kind: 'none' }, seat.workEtag)
              await mail(
                work,
                id,
                seat.scopeRef,
                `Lance closed thread ${id}.`,
                `${body.requestId}:closed:${seat.scopeRef}`
              )
            } catch (error) {
              errors.push(reason(error))
            }
          }
        } catch (error) {
          errors.push(reason(error))
        }
      }
      return {
        ok: errors.length === 0,
        closed: true,
        outcome: errors.length ? 'seat_refused' : 'closed',
        reasons: errors,
        thread: await read(id),
      }
    },
  }
}
