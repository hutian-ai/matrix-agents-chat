# Third-party components

Project-owned source is MIT licensed. Third-party components retain their own licenses; this file does not replace their license texts. Packages are installed from the frozen `pnpm-lock.yaml`, which also records transitive dependencies. Their license files remain in the installed packages.

| Direct component | Version | Declared license | Role |
| --- | --- | --- | --- |
| matrix-js-sdk | 45.0.0 | Apache-2.0 | SDK runtime |
| c12 | 3.3.4 | MIT | Private local configuration |
| citty | 0.2.2 | MIT | CLI |
| h3 | 2.0.8 | MIT | Local HTTP routes |
| srvx | 1.0.8 | MIT | Local static service |
| tinyexec | 1.3.1 | MIT | External CLI invocation |
| proper-lockfile | 4.1.2 | MIT | Local operation locks |
| write-file-atomic | 7.0.1 | ISC | Local receipt / session writes |
| envalid | 9.0.0 | MIT | Configuration validation |
| vue | 3.5.44 | MIT | Web UI |
| vite | 8.3.5 | MIT | Web build |
| @vitejs/plugin-vue | 6.0.10 | MIT | Vue build |
| typescript | 6.0.3 | Apache-2.0 | Types and SDK build |
| tsx | 4.23.1 | MIT | Local development entry points |
| @types/node | 24.13.3 | MIT | Type declarations |
| @types/proper-lockfile | 4.1.4 | MIT | Type declarations |
| @types/write-file-atomic | 4.0.3 | MIT | Type declarations |

`patches/matrix-js-sdk@45.0.0.patch` modifies an upstream Apache-2.0 component's timeout handling; the upstream license continues to apply. The core package imports the SDK as a dependency rather than bundling or relicensing it.

The deployment uses separately distributed [Synapse](https://github.com/element-hq/synapse) (`matrixdotorg/synapse:v1.164.2`, AGPL-3.0) and [PostgreSQL](https://www.postgresql.org/about/licence/) (`postgres:18.6-alpine`, PostgreSQL License). These services and their images retain their own notices. They are not included in the SDK tarball.

[Harness Dock](https://github.com/hutian-ai/harness-dock) is an optional external execution integration. Its SDK, server, device application, dependencies and notices are supplied by that project; matrix-team-chat does not vendor its source or credentials.

The optional interactive host uses `@harness-dock/client` from the project's `sdk-v0.1.2` distribution as a development dependency (MIT). It is not a dependency or bundled part of the core Matrix SDK tarball.
