import { createInterface } from 'node:readline';
import { appendFileSync, existsSync } from 'node:fs';

const [auditPath, label, marker, mode] = process.argv.slice(2);
const audit = (data) => appendFileSync(auditPath, JSON.stringify({ ...data, label, pid: process.pid }) + '\n');
audit({ event: 'started', markerPresent: !marker || existsSync(marker) });
if (marker && !existsSync(marker)) process.exit(17);
let calls = 0;
const input = createInterface({ input: process.stdin });
input.on('close', () => process.exit(0));
input.on('line', (line) => {
  const request = JSON.parse(line);
  audit({ method: request.method, tool: request.params?.name });
  if (request.id === undefined) return;
  let result;
  if (request.method === 'initialize') result = { protocolVersion: request.params.protocolVersion,
    capabilities: mode === 'resources' ? { resources: {} } : { tools: {} }, serverInfo: { name: 'owned-offline', version: '1' } };
  else if (request.method === 'tools/list') result = { tools: ['echo', 'blocked'].map((name) => ({
    name, description: `Owned ${name} fixture`, inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
  })) };
  else if (request.method === 'tools/call') result = { content: [{ type: 'text', text: `OWNED_MCP_ECHO:${label}:${++calls}:${request.params.arguments?.value ?? ''}` }] };
  else if (request.method === 'resources/list') result = { resources: [{ uri: `owned://${label}/state`, name: 'state',
    description: `OWNED_MCP_RESOURCE:${label}:${++calls}` }] };
  else if (request.method === 'resources/templates/list') result = { resourceTemplates: [] };
  else if (request.method === 'ping') result = {};
  else { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unknown method' } }) + '\n'); return; }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
});
