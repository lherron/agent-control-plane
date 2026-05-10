import { json, unprocessable } from '../http.js'
import { parseJsonBody, requireRecord } from '../parsers/body.js'
import type { RouteHandler } from '../routing/route-context.js'
import { withDurableWorkflowKernel } from '../workflow-runtime.js'

export const handlePublishWorkflow: RouteHandler = async ({ request, deps }) => {
  const body = requireRecord(await parseJsonBody(request))

  let definition: unknown
  try {
    definition = withDurableWorkflowKernel(
      deps,
      (kernel) => kernel.publishWorkflowDefinition(body as never),
      { save: true }
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    unprocessable('workflow_validation_error', message)
  }

  return json({ definition }, 201)
}
