# Delegated work and session context isolation

Lance's clarification, October 1, 2026, extended the same day with the
asynchronous-flow and visibility goals below. This records the product goals to
carry into the next reconciler specification iteration; it is not a specification.

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

## Asynchronous work: requesting is a write, not a message

**Move from agent-driven dispatch to an asynchronous flow, while keeping, and
even promoting, cross-agent conversation.**

Today an agent gets work done by messaging another agent directly, which births
or wakes that agent's seat. The requesting turn acts as the scheduler: it starts
the worker, holds the reply obligation, and has to notice when work stalls. That
couples every delegation to the requester's attention and context.

Instead, requesting work records intent in the ledger. The requester creates the
named subtask with its brief, who is asking, and which specialist should do it,
then returns to its own work. It sends no message to start the work, births no
seat, and owes no follow-up.

The reconciler starts recorded delegated work. It notices requests and starts
them when they are ready: inputs available, nobody already working on them,
capacity free. Dependencies are one reason to wait, but not the reason the
reconciler exists. Its purpose is to take scheduling, starting and
stall-noticing off the requesting agent. Results come back asynchronously when
the work completes, rather than through a requester waiting on a reply.

Cross-agent conversation remains first-class and is encouraged. Requester, worker
and sibling workers share the owner's task room, and questions, clarifications,
progress notes and peer coordination are ordinary messages there. Messaging
keeps its existing behavior, including waking or starting the addressed seat;
the asynchronous flow removes the need for the requester to drive delegated work
by message, without restricting conversation.

## Who is asking and who is working

The requester and the workers in flight are first-class facts on tasks and
subtasks, not something inferred from message history. Anyone working on an owner
task or its subtasks can see who requested each piece, who it is assigned to, who
is actively holding it, and its state. A running session alone is not proof of
work in progress. Holding the work while the worker's session has ended reads as
stalled, and recovering from that is a deliberate decision rather than an automatic
takeover. The shared project timeline is the activity history; no separate
presence system is intended.

## Scope and success

Getting a diagram is an illustrative concern. The broader goal applies whenever
a piece of work benefits from a different set of skills, tools or focused
investigation. A diagram pipeline alone does not establish that the delegation
and context-isolation problem has been solved.

Success means the primary agent can request a contribution without becoming the
specialist, the separate session has enough relevant context and capabilities
to do that work, and the result returns in a form the primary agent can use.
Requesting that help should remain lightweight: writing the request should be
the requester's whole job. The work then starts, progresses and reports back
without the requester driving it, and the requester and workers can still talk
whenever that helps. The next specification should be evaluated against these
goals before adding further scheduling or lifecycle machinery.
