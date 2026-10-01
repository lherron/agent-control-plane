# Delegated work and session context isolation

Lance's clarification, October 1, 2026. This records the product goal to carry
into the next reconciler specification iteration.

**Allow a separate session to load the skills, tools and context needed for a
piece of work, keeping the primary work agent's context focused.**

A primary agent needs to delegate a concern without loading all the specialist
instructions, tool interactions and intermediate investigation into its own
conversation. The delegated session can build the working context appropriate
to that concern. The primary agent receives the useful result and continues its
main work.

A named subtask is the durable representation of that delegation. It identifies
the concern, anchors a separate execution scope, links it to the owner's work
and gives its result somewhere to live. It is analogous to a subagent or a
delegated assignment, while remaining independently addressable and able to
outlive the requesting turn.

The delegated session retrieves the relevant brief, source references and task
context, and loads the skills and tools needed for its assignment. Sharing the
owner's work context does not mean merging the sessions' conversations. The
primary agent needs the output and any decisions relevant to integration, rather
than the specialist's full working transcript.

The reconciler supports arranging and coordinating these delegated sessions.
Readiness checks, dispatch and dependency handling are supporting machinery.
Keeping work moving is a consequence of the design; context isolation through
delegation is its purpose.

Getting a diagram is an illustrative concern. The broader goal applies whenever
a piece of work benefits from a different set of skills, tools or focused
investigation. A diagram pipeline alone does not establish that the delegation
and context-isolation problem has been solved.

Success means the primary agent can request a contribution without becoming the
specialist, the separate session has enough relevant context and capabilities
to do that work, and the result returns in a form the primary agent can use.
Requesting that help should remain lightweight. The next specification should
be evaluated against this goal before adding scheduling or lifecycle machinery.
