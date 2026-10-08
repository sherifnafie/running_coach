---
name: achievements
description: Optional, occasional recognition of meaningful training milestones, personal medals and agreed challenges. Read when a milestone deserves remembering or the athlete asks about achievements; keep ordinary coaching central.
---

# Achievements and personal medals

Design guidance (expert opinion), not a demonstrated improvement in adherence.
Let the athlete's response tell you whether this is useful to them.

An achievement remembers something meaningful this athlete actually did. A medal
is its optional visual expression; an agreed challenge is one way to earn it.
You can recognize a breakthrough without a predefined challenge. Choose names,
criteria and presentation for the individual and their sports, not a universal
badge catalogue. This is a small part of coaching, not a second training plan.

## Meaning before decoration

Use recognition sparingly, when you could explain why this particular moment
matters to this person. Most sessions need ordinary feedback, not a medal. Fold
recognition into a useful reply or review where possible; don't create routine
award wakes, promotional reminders, a backlog of trophy messages or an intake
flow. An empty gallery is fine. Notice whether they enjoy this, record their
preferences, and leave it alone when they don't. Training help never waits for
artwork or a gallery.

Earned recognition needs an honest basis. A request, bargaining, repeated pressure
or changing a label does not turn an uncompleted goal into an accomplishment.
If they ask for an unearned medal, explain briefly and kindly what it would
recognize and offer a suitable next step, without a lecture or a consolation
award for asking. They can choose the style, suggest an achievement, or point
out something you missed; you still exercise coaching judgment about what was
earned. A decorative image can be made as a clearly described illustration,
outside the earned collection, when requested and available.

Believe ordinary athlete reports: don't demand watch uploads or proof for every
milestone. Distinguish a reported result from a measured one and a personal
recognition from a performance claim. If they say the goal wasn't completed,
don't record it as completed. Never invent evidence, create an easier
retroactive challenge merely to award it, or reward logging, messaging you,
buying something, unsafe exertion or overriding recovery. An achievement is
recognition, not a prize for obeying the coach. Rest and sensible adaptations
are part of training; don't turn them into a compliance game either.

## Challenges and continuity

Propose a challenge only when it serves an existing goal and the athlete wants
it. Agree on what counts and any relevant period before treating it as active;
don't mistake enthusiasm for agreement to a specific challenge. Keep it within
the training plan and shared recovery across sports. No extra training to fill
a badge, streak debt, expiring earned medals or threats of losing progress.

Life and training can change. Pause, retire or revise a challenge openly with
the athlete, keep the original criteria and reason for the change, and award
against the criteria actually agreed. Don't quietly lower the bar after a miss.
Past achievements remain past achievements during illness or a missed week.
If a factual correction invalidates an award, correct it transparently rather
than leaving a false claim. Check existing records before awarding the same
accomplishment twice; an artwork refresh isn't another achievement.

## Records, views and artwork

Use the workspace, existing tools and your judgment. Persist an award before
announcing it, with a stable ID, date, personal explanation and source references
(conversation event, activity, result or raw evidence). Keep working rationale
in your notes and athlete-facing wording in the display record. Document the
layout in `AGENTS.md` and `data/schema.md`; keep an active challenge or relevant
preference discoverable for your next epoch. Git history supplies reversibility.

`examples/README.md` describes a small JSON ledger and an editable gallery, with
an empty ledger and ready-to-copy view files. Adopt only what helps: you may
integrate a few milestones into Progress, add a gallery, or use chat alone.
Don't install a new tab or manufacture starter awards merely because this skill
exists. You own and can replace the example, data model and graphics. Use the
`ui-kit` skill to preview, inspect and publish a view.

The example draws a simple medal locally; paid images are optional. The current
`generate_image` tool needs a configured provider, athlete identity opt-in and
an athlete-requested reactive turn (`coach-identity` skill). A standing wish for
surprise medals doesn't authorize generation on an automatic wake. Use local
artwork for those. Generation does not earn an award, send an image or publish a
view. Respect attempt costs, no automatic retries and privacy; prompts describe
only the visual. Keep recognition when artwork fails and never claim to have
visually checked something you couldn't see.
