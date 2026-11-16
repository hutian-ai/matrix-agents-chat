# matrix-team-chat

- Use official matrix-js-sdk and Synapse for rooms, identities, membership, messages and history.
- This is an independent communication SDK, CLI and local web client, not a message engine, host transaction library or Agent Harness.
- Develop normal product functionality in small stages based on real use cases. Keep room operations importable without local files, logging or CLI side effects; CLI commands call those same operations. Use product-oriented naming and runtime logs; keep stage progress in development records.
- Matrix native permissions, history visibility and transaction IDs are authoritative. Never claim strict historical revocation, cross-device deduplication, immutable events, E2EE or host-transaction support.
- Host owns business authorization, model execution, budgets and termination. Addressing never grants access or runs an agent.
- hutian facts remain in its Docs Hub. Do not reconnect to hutian or touch its source/runtime/configuration.
- TypeScript ESM, explicit .js imports, type-only imports; no enums or parameter properties.
- Preserve private old-source snapshot and experiment evidence; do not maintain two production message engines.
- Credentials only in private local files. Do not log config/raw SDK errors or reuse another application's credentials. Push or publication requires the user's authorization. Local commits normally follow the stage workflow below.

## Incremental product delivery

- The user requested rebuilding this project in small stages and explicitly confirming each stage before the next. Read docs/development.md for the current stage and confirmation state.
- Implement and verify the current authorized stage as usable product functionality, then report its behavior and limitations. Advance only after direct human confirmation in this chat; silence or a question does not advance the stage. Do not structure implementation as a tutorial or restrict explanations to one concept.
- Keep the latest completed stage uncommitted so the user can review its diff. Only after the user explicitly authorizes the next stage, first create one local commit for the previous verified stage, then start the next stage. Include the stage number and result in the title; never mix the next stage into that commit. Keep credentials, private snapshots and runtime data excluded. Do not push without authorization.
- Do not prebuild later stages or restore archived modules into the active project. Start services, connect cloud resources or invoke models only when required by the authorized current stage.
- Preserve completed stages as private snapshots before changing them, and update the stage record after verification. Keep source/evidence and credential-containing state private.
- The pre-rebuild archive and stage metadata are under .local/learning-replay/ (a historical directory name, not a teaching workflow). Existing private experiment databases, credentials and older snapshots remain in .local/ unchanged.
- Keep delivery notes concise: explain what changed, how to use it, the observed verification result and material limitations.


## Current delivery authorization (2026-11-04)

The user explicitly authorized continuous completion of this project and pushing the finished source, superseding per-stage pauses for this delivery. They explicitly selected keeping GitHub private. Keep meaningful stage commits, complete real-use verification and push the existing repository without changing visibility. Do not publish npm, a public Release or an X post.

The current product includes native Matrix communication, a local multi-room / multi-Agent web client, human-directed handoff, independent Docker setup, passwordless Application Service identity provisioning, CLI identity profiles and optional Harness Dock execution. Long-term hutian world, project management, memory and autonomous collaboration remain external concerns.

Web execution uses an independent host worker so web process failure does not close the Dock application connection. Preserve original job / receipt hashes; never replay an unknown execution. Worker / Dock failure still requires observing the original result and may be terminal; do not promise arbitrary process failures preserve model execution.
