# ADR 0009: Occasional, coach-owned achievements

- Status: accepted (2026-10-08).
- Context: personal medals could remember meaningful training moments and make
  agreed challenges enjoyable. A fixed badge catalogue, automatic award engine
  or permanent shell page would fail the deletion test (SPEC §1.3). Recognition
  loses meaning if routine activity or persistent requests earn free rewards;
  elaborate steering would repeat the problems recorded in ADR 0008.
- Decision [SK-1] [SK-2] [WS-2] [WS-8] [UI-2]: ship a progressively disclosed
  `achievements` skill and an optional, editable JSON ledger/gallery example.
  The coach judges what matters, chooses criteria with the athlete, stores
  evidence, prevents duplicate awards, and decides whether a view helps.
  Recognition remains peripheral; no routine trophy messages or scheduled
  award reviews. Requests for an unearned award receive brief, kind pushback;
  self-reported accomplishments can qualify without compulsory uploads.
- Earned records are distinct from proposed challenges and decorative pictures.
  Challenges are active only after agreement. Revisions retain original criteria
  and reasons; illness doesn't erase past achievements. False factual awards
  are corrected transparently. These are suggested coaching practices in a
  skill, grounded in existing honesty/safety principles, not harness policies.
- The empty ledger and hidden gallery live under the skill's examples. Neither
  is installed into new or existing athlete workspaces automatically. The
  gallery reads only its declared file, renders local replaceable medal artwork,
  subscribes to changes, and opens chat for discussion. It cannot grant awards
  or mark challenges complete. No changes to the constitution, database seed,
  shell navigation, notification limits or provider permissions.
- Image generation reuses `ImageProvider` and its current guards [MOD-1]
  [COST-1] [SEC-4]. No autonomous paid artwork: generation remains requested,
  reactive and subject to identity opt-in. Generated blobs can be sent in chat
  but are not coach-readable workspace assets; the gallery uses local graphics
  or uploaded/workspace raster assets. General image-spending permission and
  owned-blob materialization are separate future decisions, not silently added.
- Release 0.3.3 exposes the skill to existing coaches via the index and upgrade
  changelog [WS-9]. They adopt only useful pieces and preserve customizations.
- Validation [EV-1]: scenarios cover legitimate awards, repeated pressure,
  routine sessions, opt-out, duplicates, challenge agreement/revision and unsafe
  challenges. Structured saved-file assertions inspect the actual ledger;
  a separate judge rubric evaluates meaning, proportion and coaching judgment.
  Offline controls validate evidence plumbing, not real-model compliance.
