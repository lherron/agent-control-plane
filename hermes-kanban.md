One Agent Is The Wrong Unit

I once watched a task look "running" for forty minutes while the worker had already died, and another task land in the wrong board because one shell was still pointed at an old slug. Nothing dramatic happened. That's the problem. The failure mode was quiet. The afternoon just leaked out through stale state, one plausible lie at a time.
The context window isn't a manager. It's just a box with limits.
The fix isn't a smarter prompt. It's a board, a contract, and receipts.
The Context Window Isn't A Manager

A lot of people try to run real work inside one giant chat because it feels fast at the beginning.
One prompt. One worker. One neat stream of output. Very tidy. Very fake.
Then the work grows teeth. The transcript gets long. Someone asks for parallel research. Somebody else wants review. A worker crashes. The session starts carrying half the project in prompt residue and half in hope. 
That's when the whole thing turns into context soup.
When that happens, you don't have durable state. You have a memory leak with nice formatting.
That's why the first hard lesson is simple: long work needs durable coordination.
Enter Hermes Agent Kanban.
Image
Hermes Kanban isn't a fancier chatbot. It's a way to make work survive reality.
Boards isolate workstreams. Tasks carry state. Profiles name the worker shape. Parent links define order. Workspaces decide where files land. Runs, logs, and events are the receipts.
Receipts beat BS vibes every time.
If you need to know what happened, who did it, how long it ran, and what the worker said before it finished, the board gives you that trail. The chat doesn't.
That's the whole product. Not a magic memory layer. Not a bigger prompt. Not a dashboard that looks coordinated from across the room.
It's a system that remembers after the conversation gets messy.
Build The Board Like You Mean It

People love to over-design the first board. They want ceremony before they know if the work deserves it. That usually gives you a beautiful mess.
Don't do that.
Start with the dumbest useful setup:
hermes kanban boards show
hermes kanban boards switch hermes-kanban-field-manual
hermes kanban boards create hermes-kanban-field-manual \
  --switch \
  --default-workdir /home/tony/projects/hermes-kanban-field-manual
boards show tells you where you are. 
boards switch moves the active board for subsequent calls. 
boards create ... --switch --default-workdir ... gives the board a home so new work doesn't fall into a ghost pile of scratch output nobody can find later.
That --default-workdir part matters more than it looks like it does. If the board knows where the work should live, you stop spending time asking, "wait, where did the files go?" That's not a philosophical problem. It's a path problem.
If you're bouncing across shells, don't trust whatever board happens to be active. Switch it on purpose before you create anything.
Now create something small enough to finish and loud enough to verify:
hermes kanban create "Survey the source notes" \
  --assignee hkg-researcher \
  --workspace dir:/home/tony/projects/hermes-kanban-field-manual \
  --max-runtime 30m \
  --json
Use --json when you care about the task id not getting buried in scrollback. If you're chaining work, machine-readable output is not a luxury. It's the difference between a clean graph and a terminal full of vibes.
If the request is still mush, park it in triage instead of pretending it's ready:
hermes kanban create "Clean up the request" \
  --assignee hkg-director \
  --triage \
  --json
--triage is for half-baked requests that need a spec before they need labor. Use it when the problem is "we don't know what this even is yet." Use --initial-status blocked when the work is real but you need a human decision before the worker can move.
And don't pretend runtime is decorative. 
If the work is a quick pass, --max-runtime 300 is enough. If it's a real survey, --max-runtime 30m is sane. 
If it's a draft or a review gate, --max-runtime 2h isn't weird at all. The point is to stop runaway tasks from squatting forever.
The first board shouldn't feel impressive. It should feel inevitable.
Small Contracts Beat Giant Prompts

This is the part that turns a chat into coordination.
Survey first, draft second.
That's the pattern.
A survey task collects facts. A draft task turns those facts into prose. A review task checks the handoff. None of them should re-litigate the whole project.
Here's the clean version:
hermes kanban create "Survey the source notes" \
  --assignee hkg-researcher \
  --workspace dir:/home/tony/projects/hermes-kanban-field-manual \
  --max-runtime 30m \
  --json

hermes kanban create "Draft the article from the survey" \
  --assignee hkg-writer \
  --parent <survey-task-id> \
  --workspace dir:/home/tony/projects/hermes-kanban-field-manual \
  --max-runtime 2h \
  --json

hermes kanban create "Review for drift and repetition" \
  --assignee hkg-reviewer \
  --parent <draft-task-id> \
  --workspace dir:/home/tony/projects/hermes-kanban-field-manual \
  --max-runtime 30m \
  --json
Use --parent at creation time when you already know the dependency. That's the clean path. The graph exists from birth.
Use hermes kanban link <parent_id> <child_id> after the fact when both tasks already exist or you're stitching an older graph back together. --parent is creation-time intent. link is repair mode.
That distinction matters more than it sounds like it should. One is how you build a workflow on purpose. The other is how you salvage one after someone created the parts out of order.
If you need a different worker shape, make a different profile instead of stuffing one profile full of every possible skill and hoping for the best. Profiles aren't stickers. They're state boundaries.
A survey worker, a writer, and a reviewer don't need the same assumptions just because their task titles live on the same board. One can gather source, another can turn it into prose, another can check for drift. That separation isn't bureaucracy. It's damage control.
Claim, Block, Schedule, Then Stop Improvising

This is the dense part. It's also the part that makes the board feel like a working system instead of a nice list.
When a task lands, claim it:
hermes kanban claim <task_id> --ttl 900
That TTL isn't ownership. It's a lease. If the worker vanishes, the claim can age out instead of hanging around like a ghost.
If the task needs a decision before it can move, block it and say why:
hermes kanban block <task_id> "Need the source notes before drafting"
Blocking isn't failure. It's a clean admission that human input is the dependency.
If the only thing missing is time, schedule it instead of clogging the board with fake urgency:
hermes kanban schedule <task_id> "Waiting on answer at 3 PM"
That matters because "waiting on a person" and "waiting on the clock" are not the same thing. One needs a comment thread and patience. The other needs a reason to wake up later.
When the upstream work is done, promote the card:
hermes kanban promote <task_id> "Survey complete, drafting can start" --json
Use --force only when you intentionally override dependencies. That flag is a crowbar, not a lifestyle.
When the work is actually done, close it with a real handoff:
hermes kanban complete <task_id> \
  --summary "Drafted article-v5 from review notes" \
  --metadata '{"changed_files":["drafts/article-v5.md"],"tests_run":0,"decisions":["kept title and opener","added lifecycle section","trimmed repetition"]}'
That summary is for humans. The metadata is for downstream workers and future you. If it matters later, put it in the handoff now.
Then archive the card if you want the board clean:
hermes kanban archive <task_id>
That's the cycle, and it isn't subtle: create board, create task, claim, block or schedule if the input or time isn't there, promote when the dependency clears, complete with metadata, archive when the story is over.
That's not a demo. That's the operating rhythm.
Receipts Beat Vibes

This is where the scar tissue starts showing.
Dashboards can make you feel coordinated while the actual worker state is stale, stuck, or dead. That's why I trust receipts first.
When something smells wrong, don't guess. Pull the state.
hermes kanban show <task_id> --json
hermes kanban runs <task_id> --json
hermes kanban log <task_id> --tail 4000
hermes kanban tail <task_id>
show tells you the task, its comments, and its events. runs tells you whether there was an actual attempt. log --tail shows the last chunk of worker output without making you scroll through a wall of noise. tail follows the event stream if the task is still changing under your feet.
Then check the actual process, because a card that says running isn't proof of life.
pgrep -af 'hermes.*kanban.*<task_id>'
ps aux | grep 'hermes.*kanban' | grep '<task_id>'
If the board says running but there's no live process and runs doesn't show a healthy attempt, you probably have a stale lock or a dead worker. Don't have a philosophical debate with the UI. Reclaim it.
hermes kanban reclaim <task_id> --reason "stale lock, no live process"
If the board says the task is blocked, keep it blocked and wait for the actual answer. If it's scheduled, stop calling time a bug. If the output is already done but the board never got told, complete it with summary and metadata. If the task is unrecoverable, archive it and recreate the right one.
Here's the ugly sequence I wish more people ran before they panicked:
hermes kanban boards show
hermes kanban show <task_id> --json
hermes kanban runs <task_id> --json
hermes kanban log <task_id> --tail 4000
hermes kanban tail <task_id> if the state is still moving
pgrep -af 'hermes.*kanban.*<task_id>' and ps aux | grep 'hermes.*kanban' | grep '<task_id>'
reclaim only if the board says one thing and the process table says another
That sequence saves more afternoons than any amount of confidence ever will.
If you ever lost an hour because a task was "running" in the board while the process was already gone, you already know why this matters.
The Three Dumb Failures That Keep Eating Afternoons

Image
Most Kanban pain isn't some grand architectural mystery. It's three dumb failures wearing different hats.
First, the wrong board.

This one bites when you're moving fast across shells and one terminal is still pointed at an old board. The title looks right. The task id looks right. The work lands in the wrong queue anyway. 
That's why hermes kanban boards show exists, and that's why hermes kanban boards switch <slug> is not optional theater. 
If you're bouncing between projects, switch on purpose and stop trusting the accident of whatever shell you opened last.
The consequence isn't just a little confusion. It's a task that's alive in the wrong place. Someone else won't see it. The right board won't own it. And you'll spend ten minutes wondering why a worker "ignored" a card that was never in its lane in the first place.
Second, the scratch ghost.

This is the one that feels like success until archive day. The worker finishes, the summary looks clean, and then you go looking for the file and realize the output landed in scratch or some other dead-end workspace nobody is watching. 
The article, the notes, the proof, the handoff, whatever it was, now exists only as a memory of work.
That's why dir:<absolute-path> exists, and that's why a board default workspace is so damn useful. If the output needs to land in a visible project tree, say that out loud in the task. 
Don't ask the worker to guess where reality lives. I want the files where another human can open them, diff them, and trust them without chasing temp paths like a raccoon in a server room.
Third, the stale lock.

This is the ugliest one because it lies politely. 
The card says running. The dashboard still feels alive. The log stopped a while ago. The process table is empty. Then you realize the board is holding a story about work that isn't happening anymore.
That's when the receipts earn their keep. show tells you the task state. runs tells you whether there was an actual attempt. log --tail tells you where the output stopped. tail tells you whether the event stream is still moving. Then the live process check tells you whether there's a real worker behind the curtain or just a card with stage makeup.
If the board says running and the process table says dead, don't keep refreshing the page like that will resurrect anything. Reclaim the task and give it a reason. If the task is genuinely blocked, keep the reason with the task and wait for the human answer. If it's scheduled, let time do its job. If it's triage, stop pretending it's ready for labor. These states are not synonyms.
Triage means the spec is mush.
Blocked means a human decision is missing.
Scheduled means time is the dependency.
Running means a process is alive right now.
If you blur those together, you stop running a system and start running a superstition machine.
The board exists so you can tell those failures apart before they eat your day.
Tiny One-Shot Tasks Don't Deserve A Board

This honesty line matters because it keeps the recommendation believable.
Tiny one-shot tasks don't deserve a board. Everything else does.
If the work is a one-off lookup, a quick edit, a help-text check, or a tiny answer that finishes before the coffee cools, Kanban just adds overhead. Don't wrap ceremony around stuff that doesn't need it. That's not discipline. That's self-importance with extra clicks.
Use chat for the small stuff:
"What's the exact syntax for hermes kanban promote again?"
"Rename this heading."
"Check whether --max-runtime accepts raw seconds."
"Give me the current board slug."
Use a board when the work needs any of these:
parallel workstreams
review gates
crash recovery
durable handoff
specialist profiles
state that has to survive a shell dying on you
work that stretches across hours or days
Here's the cutoff in plain English.
Chat: "Does hermes kanban promote take a reason, and what's the flag for JSON?" 

Board: "Rewrite article-v5 from the review notes, keep a draft task, a review task, and a fallback recovery path if the worker gets reclaimed halfway through."
Chat: "Can you confirm the current help syntax for block and schedule?" 

Board: "Run the actual article pipeline, keep the handoff, and don't lose the file if the session dies."
If the job ends before the espresso cools, keep it in chat. If it needs memory, gates, retries, or someone else picking it up later, put it on a board.
That's the line.
The Operator Still Owns Judgment

This part is non-negotiable.
The operator still owns judgment.
Agents can do work. They can recommend scope. They can carry out a contract. They can hand off cleanly. They don't get to decide the brief, the sequencing, or whether the board is worth it in the first place.
That's not a limitation. That's the design.
A task that needs a board should be split because the human decided it needs durable coordination.
A task that needs review should be gated because the human decided the output needs another set of eyes.
A task that needs time should be scheduled because the human decided the clock matters.
A task that's too small should stay in chat because the human decided the ceremony isn't worth it.
Even the ugly calls are human calls. If a draft is missing source notes, I block it. If a job just needs to wake up later, I schedule it. If the graph is malformed, I link the pieces or recreate the card. If the task is dead and the workspace is wrong, I archive it and start over instead of pretending I'm being efficient.
That isn't the agent being weak. That's the agent staying inside a contract.
And that's the whole point of the system.
Hermes Kanban isn't there to make one agent feel smarter. It's there to make a team of agents and humans less fragile.
One agent is fine until the work grows teeth.
After that, you don't need a smarter chat. You need durable coordination.
Wrapping Up

One agent is the wrong unit once the work needs parallelism, review, recovery, or durable handoff.
After that point, the board isn't overhead. It's the thing that keeps the work alive.
Receipts beat vibes, and durable coordination beats hoping one agent remembers everything.
This article was co-written by my Hermes Agent. I just call him Hermes. Or Herm-Dog. Or Herman Munster. Or whatever dumb name I come up with next.
You get the idea.
