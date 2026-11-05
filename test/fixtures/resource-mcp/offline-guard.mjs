import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';

const audit = process.env.RESOURCE_MCP_NETWORK_AUDIT;
if (!audit) throw new Error('Offline MCP audit path is required');
fs.appendFileSync(audit, JSON.stringify({ event: 'guard-installed', pid: process.pid }) + '\n');
const deny = (api) => () => {
  fs.appendFileSync(audit, JSON.stringify({ event: 'network-attempt', api, pid: process.pid }) + '\n');
  throw new Error(`Offline MCP test blocked ${api}`);
};
globalThis.fetch = deny('fetch');
for (const [object, names, prefix] of [
  [http, ['request', 'get'], 'http'], [https, ['request', 'get'], 'https'],
  [net, ['connect', 'createConnection'], 'net'], [tls, ['connect'], 'tls'],
  [dns, ['lookup', 'resolve', 'resolve4', 'resolve6'], 'dns'],
  [dnsPromises, ['lookup', 'resolve', 'resolve4', 'resolve6'], 'dns.promises'],
]) for (const name of names) object[name] = deny(`${prefix}.${name}`);
net.Socket.prototype.connect = deny('net.Socket.connect');
syncBuiltinESMExports();
