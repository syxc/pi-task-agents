import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve(fileURLToPath(new URL('../artifacts/rpc-smoke/', import.meta.url)));
const run = join(root, new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(run, { recursive: true, mode: 0o700 });
const extension = process.env.PI_TASK_EXTENSION || fileURLToPath(new URL('../src/extension.ts', import.meta.url));
const proc = spawn(process.env.PI_EXECUTABLE || 'pi', [
  '--mode', 'rpc', '--session-dir', run, '--offline', '--no-mcp', '--no-extensions', '--extension', extension,
  '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-themes',
], { cwd: run, stdio: ['pipe', 'pipe', 'pipe'] });
let buffer = '';
let taskId;
let callback = false;
let commands = false;
let settled = false;
const errors = [];
const events = [];
let resolveDone;
let rejectDone;
const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
const timeout = setTimeout(() => rejectDone(new Error('RPC acceptance timed out')), 100000);
const send = (command) => proc.stdin.write(JSON.stringify(command) + '\n');
proc.stdout.on('data', (data) => {
  buffer += data.toString();
  let pos;
  while ((pos = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, pos); buffer = buffer.slice(pos + 1);
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'response' && !event.success) errors.push({ command: event.command, error: event.error });
    if (event.type === 'response' && event.command === 'get_commands') {
      commands = event.data.commands.some((entry) => entry.name === 'tasks');
      send({ id: 'prompt', type: 'prompt', message: 'Acceptance test. Call task exactly once with agent_name worker, description RPC callback check, run_in_background true, and prompt: No tools needed. Reply exactly CHILD_RPC_READY. After the task admission, reply WAITING_FOR_CHILD. When the child completion report arrives, reply exactly PARENT_CALLBACK_READY. Do not poll or call any other tool.' });
    }
    if (event.type === 'tool_execution_end' && event.toolName === 'task') {
      taskId = event.result?.details?.task_id; events.push({ type: event.type, tool: 'task', task_id: taskId });
    }
    if (event.type === 'message_end' && event.message?.role === 'custom' && event.message.customType === 'pi-task-agents:result') {
      callback = true; events.push({ type: 'completion-received', task_id: event.message.details?.task_id });
    }
    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      const text = event.message.content.filter((part) => part.type === 'text').map((part) => part.text).join('');
      if (text.includes('PARENT_CALLBACK_READY')) { settled = true; events.push({ type: 'parent-resumed' }); }
      if (event.message.stopReason === 'error') errors.push({ error: 'parent model response failed' });
    }
    if (commands && taskId && callback && settled) resolveDone();
  }
});
proc.stderr.on('data', () => {});
proc.on('error', rejectDone);
proc.on('exit', (code) => { if (!settled) rejectDone(new Error(`Pi exited early: ${code}`)); });
send({ id: 'commands', type: 'get_commands' });
try {
  await done;
  assert.deepEqual(errors, []);
  const report = { status: 'passed', commands, taskId, callback, parentResumed: settled, events };
  await writeFile(join(run, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ ...report, report: join(run, 'report.json') }, null, 2));
} finally {
  clearTimeout(timeout);
  proc.stdin.end();
  proc.kill('SIGTERM');
  const kill = setTimeout(() => proc.kill('SIGKILL'), 3000);
  kill.unref();
}
