# ADR 0003: UI preview renderer runs in the server process with Chromium's sandbox

- Status: accepted (2026-10-06)
- Context: SPEC §9.6 says the headless render runs "in the sandbox". The coach sandbox has no network and no secrets. A renderer inside it would need its own static server and bridge host, duplicated per sandbox provider.
- Decision: the Playwright renderer runs in the trusted server process. It launches Chromium with its own process sandbox enabled, serves only the athlete's `ui/` files and the kit from an ephemeral localhost server, blocks every other request via route interception, and implements the bridge host read-only against a read-only `coach.db` connection (and an empty-schema fixture for the empty-state variant). View JavaScript only ever executes inside Chromium renderer processes.
- Consequences: one renderer for every sandbox provider. If a deployment needs stronger isolation, `UiRenderer` is an interface and can be moved into the sandbox container later.
