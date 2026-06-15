import { EmptyState, ErrorBanner, FieldRow, Pill, SectionHeader } from '@/components/primitives'
import { getAgentSystemPrompt } from '@/lib/api'
import type { AgentSystemPromptInspection, ContextPromptSection, ContextRunMode } from '@/types/api'
import { useQuery } from '@tanstack/react-query'
import { Braces } from 'lucide-react'
import { useState } from 'react'
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

export function AgentPromptTemplateTab({ detail }: Props) {
  const [runMode, setRunMode] = useState<ContextRunMode>('query')
  const [projectId, setProjectId] = useState(detail.memberships[0]?.projectId ?? '')

  const query = useQuery({
    queryKey: ['agents', detail.agent.agentId, 'system-prompt', runMode, projectId],
    queryFn: () =>
      getAgentSystemPrompt(detail.agent.agentId, {
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
        <EmptyState icon={<Braces className="h-8 w-8" />} title="No prompt template" />
      )}

      {inspection !== null && <PromptTemplateInspection inspection={inspection} />}
    </section>
  )
}

function PromptTemplateInspection({ inspection }: { inspection: AgentSystemPromptInspection }) {
  return (
    <div className="space-y-10">
      <section>
        <SectionHeader
          title="Prompt template"
          right={
            <div className="flex items-center gap-2">
              <Pill tone="accent">{inspection.template.mode}</Pill>
              <Pill tone="muted">{inspection.template.kind}</Pill>
            </div>
          }
        />
        <dl>
          <FieldRow label="Source">
            <span className="mono">{inspection.template.path ?? inspection.template.kind}</span>
          </FieldRow>
          <FieldRow label="Agent root">
            <span className="mono">{inspection.agentRoot}</span>
          </FieldRow>
          <FieldRow label="Project root">
            <span className="mono">{inspection.projectRoot ?? '-'}</span>
          </FieldRow>
          <FieldRow label="Run mode">
            <span className="mono">{inspection.runMode}</span>
          </FieldRow>
          <FieldRow label="Budget">
            <span className="mono tabular-nums">
              {inspection.template.maxChars === undefined
                ? 'unbounded'
                : `${inspection.template.maxChars} chars`}
            </span>
          </FieldRow>
        </dl>
      </section>

      <TemplateZone
        tone="system"
        title="System prompt zone"
        eyebrow="Instruction stack"
        mode={inspection.prompt.mode}
        totalChars={inspection.prompt.totalChars}
        sections={inspection.prompt.sections}
      />
      <TemplateZone
        tone="reminder"
        title="Reminder zone"
        eyebrow="Global reminders"
        totalChars={inspection.reminder.totalChars}
        sections={inspection.reminder.sections}
      />
    </div>
  )
}

function TemplateZone({
  tone,
  title,
  eyebrow,
  mode,
  totalChars,
  sections,
}: {
  tone: PromptZoneTone
  title: string
  eyebrow: string
  mode?: 'replace' | 'append' | undefined
  totalChars: number
  sections: ContextPromptSection[]
}) {
  const includedCount = sections.filter((section) => section.included).length

  return (
    <PromptZoneFrame
      tone={tone}
      eyebrow={eyebrow}
      title={title}
      stats={[
        { label: 'Active sections', value: `${includedCount}/${sections.length}` },
        { label: 'Total chars', value: totalChars },
        { label: 'Zone', value: tone },
      ]}
      right={
        <div className="flex items-center gap-2">
          {mode !== undefined && <Pill tone="accent">{mode}</Pill>}
          <Pill tone="muted" mono>
            {includedCount}/{sections.length} active
          </Pill>
          <Pill tone="muted" mono>
            {totalChars} chars
          </Pill>
        </div>
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
              <TemplateSectionCard
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

function TemplateSectionCard({
  section,
  index,
}: {
  section: ContextPromptSection
  index: number
}) {
  const status = section.included ? 'active' : (section.skippedReason ?? 'skipped')
  const statusTone = section.included
    ? 'success'
    : section.skippedReason === 'when'
      ? 'warn'
      : 'muted'
  const source = sourceParts(section.source)

  return (
    <li className={section.included ? 'bg-background/10' : 'bg-secondary/10'}>
      <div className="grid gap-4 px-4 py-5 md:grid-cols-[52px_minmax(0,1fr)] md:px-5">
        <div className="hidden md:block">
          <PromptSectionOrdinal index={index} included={section.included} />
        </div>

        <div className="min-w-0 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-x-5 gap-y-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <PromptSectionOrdinal
                  index={index}
                  included={section.included}
                  className="md:hidden"
                />
                <span className="display text-[22px] leading-none text-ink">{section.name}</span>
                <Pill tone={statusTone}>{status}</Pill>
                <Pill tone="muted">{section.type}</Pill>
                {section.truncated && <Pill tone="warn">truncated</Pill>}
              </div>
              <div className="mono mt-2 text-[11px] text-muted break-all">{source.primary}</div>
              {source.resolved !== undefined && (
                <div className="mono mt-1 text-[11px] text-quiet break-all">{source.resolved}</div>
              )}
            </div>

            <div className="mono text-[11px] text-muted tabular-nums">
              {section.chars} chars / {section.bytes} bytes
            </div>
          </div>

          <div className="grid gap-3 border-t border-[color:var(--prompt-zone-border)] pt-3 sm:grid-cols-3">
            <TemplateFact label="Condition" value={formatWhen(section) ?? 'always'} />
            <TemplateFact
              label="Section budget"
              value={section.maxChars === undefined ? 'none' : `${section.maxChars} chars`}
            />
            <TemplateFact label="Output" value={section.included ? 'included' : 'not emitted'} />
          </div>
        </div>
      </div>
    </li>
  )
}

function TemplateFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="kicker text-muted">{label}</div>
      <div className="mono mt-1 break-words text-[11px] text-ink">{value}</div>
    </div>
  )
}

function sourceParts(source: string): { primary: string; resolved?: string | undefined } {
  const marker = ' -> '
  const index = source.indexOf(marker)
  if (index < 0) {
    return { primary: source }
  }

  return {
    primary: source.slice(0, index),
    resolved: source.slice(index + marker.length),
  }
}

function formatWhen(section: ContextPromptSection): string | undefined {
  const parts: string[] = []
  if (section.when?.runMode) {
    parts.push(`runMode=${section.when.runMode}`)
  }
  if (section.when?.exists) {
    parts.push(`exists=${section.when.exists}`)
  }
  return parts.length > 0 ? parts.join(', ') : undefined
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
