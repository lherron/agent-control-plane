import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { JobRunRecord, JobStepRunRecord, NormalizedFlowStep } from '@/types/api'
import { useState } from 'react'

interface StepInspectorProps {
  step: NormalizedFlowStep
  stepRuns?: Array<{ jobRunId: string; stepRun: JobStepRunRecord }>
  latestRuns?: JobRunRecord[]
}

type InspectorTab = 'definition' | 'startup' | 'expectations' | 'runs' | 'raw'

function DefinitionTab({ step }: { step: NormalizedFlowStep }) {
  return (
    <div className="space-y-3 text-xs">
      <div>
        <span className="text-muted">ID:</span>{' '}
        <span className="font-mono text-foreground">{step.id}</span>
      </div>
      <div>
        <span className="text-muted">Kind:</span>{' '}
        <span className="text-foreground">{step.kind ?? 'agent'}</span>
      </div>
      <div>
        <span className="text-muted">Phase:</span>{' '}
        <span className="text-foreground">{step.phase}</span>
      </div>
      <div>
        <span className="text-muted">Index:</span>{' '}
        <span className="text-foreground">{step.index}</span>
      </div>
      {step.timeout && (
        <div>
          <span className="text-muted">Timeout:</span>{' '}
          <span className="text-foreground">{step.timeout}</span>
        </div>
      )}
      {step.fresh !== undefined && (
        <div>
          <span className="text-muted">Fresh:</span>{' '}
          <span className="text-foreground">{String(step.fresh)}</span>
        </div>
      )}
      {step.next && (
        <div>
          <span className="text-muted">Next:</span>{' '}
          <span className="text-foreground">{step.next}</span>
        </div>
      )}
    </div>
  )
}

function StartupTab({ step }: { step: NormalizedFlowStep }) {
  return (
    <div className="space-y-3 text-xs">
      {step.input && (
        <div>
          <div className="text-muted mb-1">Input:</div>
          <pre className="bg-secondary rounded p-2 text-foreground whitespace-pre-wrap font-mono text-[11px]">
            {step.input}
          </pre>
        </div>
      )}
      {step.inputFile && (
        <div>
          <span className="text-muted">Input File:</span>{' '}
          <span className="font-mono text-foreground">{step.inputFile}</span>
        </div>
      )}
      {step.kind === 'exec' && step.exec && (
        <div>
          <div className="text-muted mb-1">Exec:</div>
          <pre className="bg-secondary rounded p-2 text-foreground whitespace-pre-wrap font-mono text-[11px]">
            {JSON.stringify(step.exec, null, 2)}
          </pre>
        </div>
      )}
      {step.branches && (
        <div>
          <div className="text-muted mb-1">Branches:</div>
          <pre className="bg-secondary rounded p-2 text-foreground whitespace-pre-wrap font-mono text-[11px]">
            {JSON.stringify(step.branches, null, 2)}
          </pre>
        </div>
      )}
      {!step.input && !step.inputFile && !step.exec && (
        <div className="text-quiet italic">No startup configuration for this step.</div>
      )}
    </div>
  )
}

function ExpectationsTab({ step }: { step: NormalizedFlowStep }) {
  if (!step.expect) {
    return <div className="text-xs text-quiet italic">No expectations defined.</div>
  }

  return (
    <div className="space-y-3 text-xs">
      {step.expect.outcome && (
        <div>
          <span className="text-muted">Outcome:</span>{' '}
          <Badge variant="outline" className="text-[10px]">
            {step.expect.outcome}
          </Badge>
        </div>
      )}
      {step.expect.resultBlock && (
        <div>
          <span className="text-muted">Result Block:</span>{' '}
          <span className="font-mono text-foreground">{step.expect.resultBlock}</span>
        </div>
      )}
      {step.expect.require && step.expect.require.length > 0 && (
        <div>
          <div className="text-muted mb-1">Require:</div>
          <div className="flex flex-wrap gap-1">
            {step.expect.require.map((r) => (
              <Badge key={r} variant="secondary" className="text-[10px]">
                {r}
              </Badge>
            ))}
          </div>
        </div>
      )}
      {step.expect.equals && (
        <div>
          <div className="text-muted mb-1">Equals:</div>
          <pre className="bg-secondary rounded p-2 text-foreground whitespace-pre-wrap font-mono text-[11px]">
            {JSON.stringify(step.expect.equals, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}

function RunsTab({
  stepRuns,
  latestRuns,
  stepId,
}: {
  stepRuns?: Array<{ jobRunId: string; stepRun: JobStepRunRecord }>
  latestRuns?: JobRunRecord[]
  stepId: string
}) {
  const filtered = stepRuns?.filter((sr) => sr.stepRun.stepId === stepId) ?? []

  if (filtered.length === 0) {
    return <div className="text-xs text-quiet italic">No recent runs for this step.</div>
  }

  return (
    <div className="space-y-2 text-xs">
      {filtered.map((sr) => {
        const parentRun = latestRuns?.find((r) => r.jobRunId === sr.jobRunId)
        return (
          <div
            key={`${sr.jobRunId}-${sr.stepRun.stepId}`}
            className="border border-border rounded p-2 space-y-1"
          >
            <div className="flex items-center gap-2">
              <Badge
                variant={
                  sr.stepRun.status === 'succeeded'
                    ? 'secondary'
                    : sr.stepRun.status === 'failed'
                      ? 'destructive'
                      : 'outline'
                }
                className="text-[10px]"
              >
                {sr.stepRun.status}
              </Badge>
              <span className="text-quiet">attempt {sr.stepRun.attempt}</span>
            </div>
            {parentRun && (
              <div className="text-quiet">
                Run: {parentRun.triggeredBy} @ {new Date(parentRun.triggeredAt).toLocaleString()}
              </div>
            )}
            {sr.stepRun.error && (
              <div className="text-destructive">
                {sr.stepRun.error.code}: {sr.stepRun.error.message}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function RawTab({ step }: { step: NormalizedFlowStep }) {
  return (
    <pre className="bg-secondary rounded p-2 text-foreground whitespace-pre-wrap font-mono text-[11px]">
      {JSON.stringify(step, null, 2)}
    </pre>
  )
}

export function StepInspector({ step, stepRuns, latestRuns }: StepInspectorProps) {
  const [activeTab, setActiveTab] = useState<InspectorTab>('definition')

  const isOnFailure = step.phase === 'onFailure'
  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-3 border-b border-border space-y-1">
        <div className="text-[10px] uppercase tracking-wide text-muted">
          Step {step.index + 1} · {step.phase}
        </div>
        <div className="font-semibold text-sm text-foreground font-mono">{step.id}</div>
        <div className="flex items-center gap-2 text-xs">
          <span
            className={
              isOnFailure
                ? 'inline-flex px-1.5 py-0 rounded text-[10px] bg-red-50 text-red-700 border border-red-200'
                : 'inline-flex px-1.5 py-0 rounded text-[10px] bg-accent/10 text-accent border border-accent/30'
            }
          >
            {step.kind ?? 'agent'}
          </span>
          {step.fresh !== undefined && (
            <span className="text-quiet">
              fresh: <span className="text-foreground">{String(step.fresh)}</span>
            </span>
          )}
          {step.timeout && (
            <span className="text-quiet">
              timeout: <span className="text-foreground">{step.timeout}</span>
            </span>
          )}
        </div>
      </div>

      <Tabs className="flex-1 flex flex-col min-h-0">
        <TabsList className="mx-4 mt-2 shrink-0">
          <TabsTrigger
            active={activeTab === 'definition'}
            onClick={() => setActiveTab('definition')}
          >
            Definition
          </TabsTrigger>
          <TabsTrigger active={activeTab === 'startup'} onClick={() => setActiveTab('startup')}>
            Startup
          </TabsTrigger>
          <TabsTrigger
            active={activeTab === 'expectations'}
            onClick={() => setActiveTab('expectations')}
          >
            Expectations
          </TabsTrigger>
          <TabsTrigger active={activeTab === 'runs'} onClick={() => setActiveTab('runs')}>
            Last Runs
          </TabsTrigger>
          <TabsTrigger active={activeTab === 'raw'} onClick={() => setActiveTab('raw')}>
            Raw
          </TabsTrigger>
        </TabsList>

        <ScrollArea className="flex-1 px-4 py-3">
          {activeTab === 'definition' && (
            <TabsContent>
              <DefinitionTab step={step} />
            </TabsContent>
          )}
          {activeTab === 'startup' && (
            <TabsContent>
              <StartupTab step={step} />
            </TabsContent>
          )}
          {activeTab === 'expectations' && (
            <TabsContent>
              <ExpectationsTab step={step} />
            </TabsContent>
          )}
          {activeTab === 'runs' && (
            <TabsContent>
              <RunsTab stepRuns={stepRuns} latestRuns={latestRuns} stepId={step.id} />
            </TabsContent>
          )}
          {activeTab === 'raw' && (
            <TabsContent>
              <RawTab step={step} />
            </TabsContent>
          )}
        </ScrollArea>
      </Tabs>
    </div>
  )
}
