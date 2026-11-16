# Contributing

Use Node.js 22.16+ and pnpm 11. Install with `pnpm install --frozen-lockfile`. Keep changes centered on reusable human / Agent communication; execution, business authorization and project management belong to the host.

Check relevant TypeScript with `pnpm check`, web changes with `pnpm web:build`, and SDK changes with `pnpm build`. Verify the shortest real use path for the change. Do not add test frameworks, fixtures, broad CI or coverage gates without a specific request.

Prefer suitable UnJS utilities for general JavaScript / TypeScript infrastructure and official SDKs for the services they implement. Keep native Matrix membership, message facts, transaction IDs and history visibility authoritative.

Never commit `.local/`, session tokens, passwords, AS secrets, model authentication, runtime logs or task receipts. Use synthetic sample content in shared evidence. Do not push, publish a release or post externally without the repository owner's authorization.

Use small commits describing the user-visible result. Source is MIT licensed; third-party licenses remain unchanged. This repository is currently private.
