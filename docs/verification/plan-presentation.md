# Plan presentation correction [UI-1, WS-2]

Checked on 7 October 2026 with Node 22.23.3, pnpm 10.28.0 and Chromium.

## Cause and change

The starter Plan view rendered `plan/current.md` directly under "Plan notes" and declared that file in its read manifest. The file mixes training rationale with working-memory conventions, including database references. The Markdown component treats raw HTML as text, so the starter file's bookkeeping comment was also unsuitable display copy. Script sanitization does not decide which prose belongs in a training screen.

Plan now reads only `plan/athlete-summary.md` under "Why this plan". Working notes remain in `plan/current.md`. The constitution, workspace map, product guide and plan/UI skills distinguish reviewed athlete copy from working notes, briefings and helper drafts. Database documentation identifies fields that actually appear in the starter screens and corrects the old claim that `coach_notes` was excluded from full exports. No database migration or training policy was added.

This is a presentation convention, not confidential storage: full exports still contain the athlete's workspace/database, and the coach can evolve future view manifests. There is no word blacklist and no claim that every future model-authored view will always use appropriate copy.

## Regression checks

The real-gateway PWA regression uses synthetic working notes containing an internal canary, a database filename, a table name and helper bookkeeping. It checks that:

- Plan's published manifest denies reading `plan/current.md` and permits the athlete summary.
- The isolated phone iframe displays the training explanation and planned volume without those internal strings.
- Updating the public summary and delivering a coach reply refreshes the explanation without reloading the iframe.
- "Discuss this plan" returns to Chat with the expected draft.

Renderer fixtures keep separate working notes and athlete explanations for both empty and sample training data. Publication checks retain the existing runtime/CSP, accessibility and 1,500 ms CPU-throttled performance requirements.

Current checks: aggregate typecheck and production build passed; 760 unit/integration tests (including runtime cassettes), all three isolated Chromium renderer tests, seven focused seed tests and all nine real-gateway PWA flows passed. Renderer tests cover all four starter views against sample and empty data, plus failed-publication controls. The required offline fast catalog passed 25 scenarios / 32 assertions with no failures or missing evidence. Those scripted controls verify the harness and graders, not live coaching behavior. All 32 local documentation links checked were present.

Two broader renderer runs passed the sample-data and negative controls but missed the empty-data performance gate in unchanged views: Progress at 1,623 ms during concurrent browser work, and Calendar at 1,702 ms while typechecking overlapped. The final run, without overlapping tests/builds, passed all three tests. These failed measurements are retained rather than treated as model-quality evidence or hidden by a relaxed threshold. Run performance checks without competing verification workloads.

## Live model check

A synthetic existing account started with the old published Plan view and a preserved custom header. Its working notes visibly contained the canary. DeepSeek V4.1 Flash through OpenCode GO used actual isolated tools to write a useful athlete summary, remove the working-file manifest read and update the Plan source. The summary omitted the canary and implementation strings.

The first bounded repair was **incomplete**: it ended after 20 steps / about 265 seconds before publication or confirmation that the fix was live. A progress message was delivered. Two previews failed the performance gate (2,304 and 1,970 ms); a subsequent Plan preview passed at 1,118 ms. Final preview/publication calls were cancelled when the turn was aborted. Concurrent verification load makes those timing measurements unsuitable for comparing UI implementations. No performance threshold was relaxed. The first turn's token-equivalent estimate was $0.0364 at the configured peak rates; it is not the provider's billing ledger.

The first attempt is not a passing autonomous-repair result. A separate continuation requested only publication of the already prepared Plan, with a five-step / 90-second limit. It completed in three steps, published **Plan v2** through the real gates, and delivered confirmation. The published phone iframe showed the athlete explanation without the internal strings, and its manifest denied working-note reads. The custom header was preserved and a before/after comparison confirmed no block or workout changes during publication. Both phases used `local-isolated`, with isolation confirmed; the key was supplied only to the trusted server in memory. The continuation's token-equivalent estimate was $0.0030.

The live view observer used immutable published bundles, the production bridge host and runtime-scoped reads. It is a component client, not phone-device or full-PWA authentication coverage; the separate gateway acceptance regression covers the actual shell and authenticated browser flow. The generated explanation also repeated the card heading and was longer than needed. Its scientific wording was not graded as coaching quality.

## Existing accounts

Seed updates preserve existing coach workspaces and immutable published view versions. An update alone therefore does not replace an older Plan screen. Use the [repair request](../self-hosting.md#updating-an-existing-coachs-plan-view), then check the published screen; a saved summary or acknowledgement alone is insufficient. The explicit request can be made in the current epoch; the updated constitution itself is loaded at the next epoch. Keep useful customizations and training data, and retain publication gates.

This check uses synthetic data. It does not certify general coaching quality or full provider conformance.
