import { Pill, StatusDot } from '@/components/primitives'
import type { JobRunRecord, JobStepRunRecord, NormalizedFlowStep } from '@/types/api'
import { useState } from 'react'

interface StepInspectorProps {
  step: NormalizedFlowStep
  stepRuns?: Array<{ jobRunId: string; stepRun: JobStepRunRecord }>
  latestRuns?: JobRunRecord[]
}

type InspectorTab = 'definition' | 'startup' | 'expect' | 'runs' | 'raw'

const TABS: ReadonlyArray<{ id: InspectorTab; label: string }> = [
  { id: 'definition', label: 'Defn' },
  { id: 'startup', label: 'Startup' },
  { id: 'expect', label: 'Expect' },
  { id: 'runs', label: 'Runs' },
  { id: 'raw', label: 'Raw' },
]

function KV({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[80px_minmax(0,1fr)] gap-3 py-2 border-b border-border/40 last:border-0">
      <span className="kicker text-muted">{k}</span>
      <span className="text-[12px] text-ink min-w-0 break-words">{children}</span>
    </div>
  )
}

function statusTone(status: string): 'success' | 'destructive' | 'warn' | 'muted' {
  if (status === 'succeeded') return 'success'
  if (status === 'failed') return 'destructive'
  if (status === 'skipped') return 'warn'
  return 'muted'
}

export function StepInspector({ step, stepRuns, latestRuns }: StepInspectorProps) {
  const [activeTab, setActiveTab] = useState<InspectorTab>('definition')
  const isOnFailure = step.phase === 'onFailure'
  const filteredRuns = stepRuns?.filter((sr) => sr.stepRun.stepId === step.id) ?? []

  return (
    <div className="h-full flex flex-col min-h-0">
      <header className="px-6 pt-7 pb-5">
        <div className="kicker text-muted mb-2">
          Step {step.index + 1} · {step.phase}
        </div>
        <div className="display text-[24px] text-ink leading-tight tracking-tight mb-3 break-all">
          {step.id}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Pill tone={isOnFailure ? 'destructive' : 'accent'}>{step.kind ?? 'agent'}</Pill>
          {step.next && step.next !== 'continue' && (
            <Pill tone="muted" mono>
              → {step.next}
            </Pill>
          )}
        </div>
      </header>

      <div className="border-b border-border/60">
        <div className="flex px-6 gap-5">
          {TABS.map((t) => {
            const isActive = activeTab === t.id
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setActiveTab(t.id)}
                className={`relative py-2 text-[12px] transition-colors ${
                  isActive ? 'text-ink font-medium' : 'text-muted hover:text-ink'
                }`}
              >
                {t.label}
                {isActive && (
                  <span className="absolute -bottom-px left-0 right-0 h-[1.5px] bg-accent" />
                )}
              </button>
            )
          })}
        </div>
      </div>

      <div className="flex-1 overflow-auto px-6 py-5 min-h-0">
        {activeTab === 'definition' && (
          <dl>
            <KV k="ID">
              <span className="mono">{step.id}</span>
            </KV>
            <KV k="Kind">{step.kind ?? 'agent'}</KV>
            <KV k="Phase">{step.phase}</KV>
            {step.timeout && <KV k="Timeout">{step.timeout}</KV>}
            {step.fresh !== undefined && <KV k="Fresh">{String(step.fresh)}</KV>}
            {step.next && (
              <KV k="Next">
                <span className="mono text-accent">{step.next}</span>
              </KV>
            )}
          </dl>
        )}

        {activeTab === 'startup' && (
          <div className="space-y-4">
            {step.input && (
              <div>
                <div className="kicker text-muted mb-2">Input</div>
                <pre className="mono text-[11.5px] leading-relaxed text-ink whitespace-pre-wrap">
                  {step.input}
                </pre>
              </div>
            )}
            {step.inputFile && (
              <KV k="Input file">
                <span className="mono">{step.inputFile}</span>
              </KV>
            )}
            {step.kind === 'exec' && step.exec && (
              <div>
                <div className="kicker text-muted mb-2">Exec</div>
                <pre className="mono text-[11.5px] leading-relaxed text-ink whitespace-pre-wrap">
                  {JSON.stringify(step.exec, null, 2)}
                </pre>
              </div>
            )}
            {!step.input && !step.inputFile && !step.exec && (
              <div className="text-[12px] text-muted">No startup config.</div>
            )}
          </div>
        )}

        {activeTab === 'expect' &&
          (step.expect ? (
            <dl>
              {step.expect.outcome && (
                <KV k="Outcome">
                  <Pill tone={step.expect.outcome === 'succeeded' ? 'success' : 'destructive'}>
                    {step.expect.outcome}
                  </Pill>
                </KV>
              )}
              {step.expect.resultBlock && (
                <KV k="Result block">
                  <span className="mono">{step.expect.resultBlock}</span>
                </KV>
              )}
              {step.expect.require && step.expect.require.length > 0 && (
                <KV k="Require">
                  <div className="flex flex-wrap gap-1">
                    {step.expect.require.map((r) => (
                      <Pill key={r} tone="muted" mono>
                        {r}
                      </Pill>
                    ))}
                  </div>
                </KV>
              )}
            </dl>
          ) : (
            <div className="text-[12px] text-muted">None.</div>
          ))}

        {activeTab === 'runs' &&
          (filteredRuns.length === 0 ? (
            <div className="text-[12px] text-muted">No runs.</div>
          ) : (
            <ul className="space-y-3">
              {filteredRuns.map((sr) => {
                const parent = latestRuns?.find((r) => r.jobRunId === sr.jobRunId)
                return (
                  <li
                    key={`${sr.jobRunId}-${sr.stepRun.stepId}`}
                    className="py-2 border-b border-border/40 last:border-0 space-y-1"
                  >
                    <div className="flex items-center gap-2">
                      <StatusDot tone={statusTone(sr.stepRun.status)} />
                      <Pill tone={statusTone(sr.stepRun.status)}>{sr.stepRun.status}</Pill>
                      <span className="mono text-[10px] text-muted">
                        attempt {sr.stepRun.attempt}
                      </span>
                    </div>
                    {parent && (
                      <div className="text-[11px] text-muted">
                        {parent.triggeredBy} · {new Date(parent.triggeredAt).toLocaleString()}
                      </div>
                    )}
                    {sr.stepRun.error && (
                      <div className="mono text-[11px] text-destructive">
                        {sr.stepRun.error.code}: {sr.stepRun.error.message}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          ))}

        {activeTab === 'raw' && (
          <pre className="mono text-[11px] leading-relaxed text-ink whitespace-pre-wrap">
            {JSON.stringify(step, null, 2)}
          </pre>
        )}
      </div>
    </div>
  )
}
