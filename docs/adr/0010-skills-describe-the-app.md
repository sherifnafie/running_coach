# ADR 0010: First-party skills describe the app; coaching knowledge is the coach's

- Status: accepted (2026-10-08).
- Context: the seed shipped about 130 KB of sports-science skills (`running`, `strength-training` with its support, programming and powerlifting docs, `plan-design`, `training-load`, `competition-prep`, `environment`, `fueling-basics`, `injury-and-pain`, `illness-return`) next to about 80 KB describing the app itself. The domain skills restated what capable models already know, fixed one textbook view of coaching in the seed, and were where eval-driven rules accumulated: the health-question gating and the mandatory plan review behind ADR 0008 lived in `intake` and `plan-design`. They also fail the deletion test (SPEC §1.3): a smarter model makes them unnecessary.
- Decision [SK-1] [SK-2]: first-party skills describe this app: procedures, data conventions and bundled tools a model cannot know from training.
  - **Kept:** `intake`, `disciplines` (rewritten as the app side of taking on a sport), `file-import`, `screenshot-extraction`, `data-hygiene`, `calendar-export`, `ui-kit`, `research`, `coach-identity`, `achievements`.
  - **Removed:** the nine domain skills above.
  - **Calculators kept:** their scripts (`plan_check.py`, `load.py`, `e1rm.py`, `vdot.py`) move into one `calculators` skill. Arithmetic is a tool, not an opinion, and small models get it wrong.
  - **Coaching knowledge:** it is the model's own, researched when needed and kept by the coach as workspace skills (SK-2). The constitution's coaching section says so.
  - **Safety:** the floor stays in the constitution (§11: red flags, pain, illness, eating and weight, crisis, substances, risky disciplines, age), not in skills.
- Alternatives rejected:
  - Keeping the skills as optional "reference": they still sit in the index, get read, and keep reintroducing rules.
  - Trimming them to principles: same problem, smaller.
- Consequences:
  - The seed shrinks and gets easier to keep current.
  - A weaker model coaches from its own knowledge with less hand-holding. The conversation benchmark (ADR 0008) and the eval suites are how to tell whether that costs quality.
  - Existing coaches get `harness.upgraded` (0.3.4) and a changelog entry to repoint script paths and write their own sport skills if they relied on the removed ones.
