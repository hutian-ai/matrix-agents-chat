import type { ServerClient } from '@harness-dock/client';
export function runtimeInventory(client: ServerClient, nodeId?: string): Promise<{ nodes: Array<Record<string, unknown>> }>;
