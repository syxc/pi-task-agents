import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.env.PI_TASK_AGENTS_TEST_SDK_ROOT;
if (!root) throw new Error('Missing isolated test SDK directory');
const entry = pathToFileURL(join(root, 'dist/index.js')).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  return specifier === '@earendil-works/pi-coding-agent'
    ? { url: entry, shortCircuit: true } : nextResolve(specifier, context);
} });
