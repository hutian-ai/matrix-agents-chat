// Only public inventory; never opens a second connection for an active owner.
export async function runtimeInventory(client, nodeId) {
  const nodes = client.listNodes().filter(n => !nodeId || n.nodeId === nodeId);
  return { nodes: await Promise.all(nodes.map(async node => {
    if (!node.connected) return { ...node, inventory: null };
    try { return { ...node, inventory: await client.node(node.nodeId).request('inventory', {}, 8000) }; }
    catch { return { ...node, inventory: null, error: 'inventory_unconfirmed' }; }
  })) };
}
