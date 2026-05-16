import { EmptyState, ErrorBanner, FieldRow, Pill, SectionHeader } from '@/components/primitives'
import type { AgentSystemPromptInspection, ContextPromptSection, ContextRunMode } from '@/types/api'
import { useQuery } from '@tanstack/react-query'
import { FileText } from 'lucide-react'
import { useState } from 'react'
import { fetchAgentSystemPrompt } from '../data'
import type { AgentDetailState } from '../types'
import {
  PromptControlStrip,
  PromptSectionOrdinal,
  PromptZoneFrame,
  type PromptZoneTone,
} from './agent-prompt-zone'

interface Props {
  detail: AgentDetailState
}

const RUN_MODES: ContextRunMode[] = ['query', 'heartbeat', 'task', 'maintenance']

export function AgentSystemPromptTab({ detail }: Props) {
  const [runMode, setRunMode] = useState<ContextRunMode>('query')
  const [projectId, setProjectId] = useState(detail.memberships[0]?.projectId ?? '')

  const query = useQuery({
    queryKey: ['agents', detail.agent.agentId, 'system-prompt', runMode, projectId],
    queryFn: () =>
      fetchAgentSystemPrompt(detail.agent.agentId, {
        runMode,
        ...(projectId.length > 0 ? { projectId } : {}),
      }),
  })

  if (query.error instanceof Error) {
    return <ErrorBanner message={query.error.message} />
  }

  const inspection = query.data?.systemPrompt ?? null

  return (
    <section className="max-w-5xl space-y-10">
      <PromptControlStrip>
        <LabeledSelect
          label="Run mode"
          value={runMode}
          onChange={(value) => setRunMode(value as ContextRunMode)}
          options={RUN_MODES.map((mode) => ({ value: mode, label: mode }))}
        />
        {detail.memberships.length > 0 && (
          <LabeledSelect
            label="Project"
            value={projectId}
            onChange={setProjectId}
            options={[
              { value: '', label: 'none' },
              ...detail.memberships.map((membership) => ({
                value: membership.projectId,
                label: membership.project?.displayName ?? membership.projectId,
              })),
            ]}
          />
        )}
      </PromptControlStrip>

      {query.isLoading && <div className="text-[12px] text-muted">Loading...</div>}

      {!query.isLoading && inspection === null && (
        <EmptyState icon={<FileText className="h-8 w-8" />} title="No system prompt" />
      )}

      {inspection !== null && <PromptInspection inspection={inspection} />}
    </section>
  )
}

function PromptInspection({ inspection }: { inspection: AgentSystemPromptInspection }) {
  return (
    <div className="space-y-10">
      <section>
        <SectionHeader title="Template" />
        <dl>
          <FieldRow label="Source">
            <span className="mono">{inspection.template.path ?? inspection.template.kind}</span>
          </FieldRow>
          <FieldRow label="Mode">{inspection.template.mode}</FieldRow>
          <FieldRow label="Agent root">
            <span className="mono">{inspection.agentRoot}</span>
          </FieldRow>
          <FieldRow label="Project root">
            <span className="mono">{inspection.projectRoot ?? '-'}</span>
          </FieldRow>
          <FieldRow label="Total chars">
            <span className="mono tabular-nums">{inspection.diagnostics.totalChars}</span>
            {inspection.diagnostics.maxChars !== undefined && (
              <span className="ml-2 text-muted">/ {inspection.diagnostics.maxChars}</span>
            )}
          </FieldRow>
        </dl>
      </section>

      <PromptZone
        tone="system"
        title="System prompt"
        eyebrow="Instruction stack"
        mode={inspection.prompt.mode}
        content={inspection.prompt.content}
        totalChars={inspection.prompt.totalChars}
        sections={inspection.prompt.sections}
      />
      <PromptZone
        tone="reminder"
        title="Reminder"
        eyebrow="Global reminders"
        content={inspection.reminder.content}
        totalChars={inspection.reminder.totalChars}
        sections={inspection.reminder.sections}
      />
    </div>
  )
}

function PromptZone({
  tone,
  title,
  eyebrow,
  mode,
  content,
  totalChars,
  sections,
}: {
  tone: PromptZoneTone
  title: string
  eyebrow: string
  mode?: 'replace' | 'append' | undefined
  content?: string | undefined
  totalChars: number
  sections: ContextPromptSection[]
}) {
  const hasContent = content !== undefined && content.length > 0
  const includedCount = sections.filter((section) => section.included).length

  return (
    <PromptZoneFrame
      tone={tone}
      eyebrow={eyebrow}
      title={title}
      stats={[
        { label: 'Included', value: `${includedCount}/${sections.length}` },
        { label: 'Total chars', value: totalChars },
        { label: 'Assembled', value: hasContent ? 'ready' : 'empty' },
      ]}
      right={
        <div className="flex items-center gap-2">
          {mode !== undefined && <Pill tone="accent">{mode}</Pill>}
          <Pill tone="muted" mono>
            {totalChars} chars
          </Pill>
        </div>
      }
      footer={
        <details>
          <summary className="group flex cursor-pointer list-none items-center gap-3 text-muted hover:text-ink [&::-webkit-details-marker]:hidden">
            <span className="h-px w-8 bg-[color:var(--prompt-zone-color)]" />
            <span className="kicker">Assembled output</span>
          </summary>
          <pre className="mono mt-4 max-h-[420px] overflow-auto whitespace-pre-wrap break-words border border-[color:var(--prompt-zone-border)] bg-secondary/45 p-4 text-[11.5px] leading-relaxed text-ink">
            {hasContent ? content : '(empty)'}
          </pre>
        </details>
      }
    >
      <div className="px-5 py-5 md:px-6">
        {sections.length === 0 ? (
          <div className="border border-dashed border-[color:var(--prompt-zone-border)] bg-secondary/20 px-4 py-5 text-[12px] text-muted">
            No sections
          </div>
        ) : (
          <ol className="divide-y divide-border/55 border-y border-border/45">
            {sections.map((section, index) => (
              <PromptSectionItem
                key={`${section.zone}:${section.name}`}
                section={section}
                index={index + 1}
              />
            ))}
          </ol>
        )}
      </div>
    </PromptZoneFrame>
  )
}

function PromptSectionItem({
  section,
  index,
}: {
  section: ContextPromptSection
  index: number
}) {
  const included = section.included
  const status = included ? 'included' : (section.skippedReason ?? 'skipped')

  return (
    <li className={included ? 'bg-background/10' : 'bg-secondary/10'}>
      <div className="grid gap-4 px-4 py-5 md:grid-cols-[52px_minmax(0,1fr)] md:px-5">
        <div className="hidden md:block">
          <PromptSectionOrdinal index={index} included={included} />
        </div>

        <div className="min-w-0">
          <div className="flex flex-wrap items-start justify-between gap-x-5 gap-y-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <PromptSectionOrdinal index={index} included={included} className="md:hidden" />
                <span className="display text-[22px] leading-none text-ink">{section.name}</span>
                <Pill tone={included ? 'success' : 'muted'}>{status}</Pill>
                <Pill tone="muted">{section.type}</Pill>
                {section.truncated && <Pill tone="warn">truncated</Pill>}
              </div>
              <div className="mono mt-2 text-[11px] text-muted break-all">{section.source}</div>
              {section.when && (
                <div className="mono mt-1 text-[11px] text-muted">when: {formatWhen(section)}</div>
              )}
            </div>
            <div className="mono text-[11px] text-muted tabular-nums">
              {section.chars} chars / {section.bytes} bytes
            </div>
          </div>

          {included && section.content !== undefined && (
            <pre className="mono mt-4 max-h-[360px] overflow-auto whitespace-pre-wrap break-words border-l-2 border-l-[color:var(--prompt-zone-color)] bg-secondary/40 p-4 text-[11.5px] leading-relaxed text-ink shadow-[inset_0_1px_0_rgba(240,232,221,0.04)]">
              {section.content}
            </pre>
          )}
        </div>
      </div>
    </li>
  )
}

function formatWhen(section: ContextPromptSection): string {
  const parts: string[] = []
  if (section.when?.runMode) {
    parts.push(`runMode=${section.when.runMode}`)
  }
  if (section.when?.exists) {
    parts.push(`exists=${section.when.exists}`)
  }
  return parts.join(', ')
}

function LabeledSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: Array<{ value: string; label: string }>
}) {
  return (
    <label className="grid gap-1.5">
      <span className="kicker text-muted">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 min-w-[180px] border border-border bg-background px-3 text-[13px] text-ink outline-none focus:border-accent"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  )
}
