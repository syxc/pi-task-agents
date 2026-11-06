import test from 'node:test';
import assert from 'node:assert/strict';
import { registerTaskAgents, toolResult } from '../src/extension.ts';

test('a full output page is preserved when the engine has advanced its byte cursor', () => {
  const output = 'a'.repeat(65536);
  const result = toolResult({ output, offset: 0, next_offset: 65536, has_more: true, final_text: 'b'.repeat(90000) });
  const visible = JSON.parse(result.content[0].text);
  assert.equal(visible.output, output);
  assert.equal(Buffer.byteLength(visible.output), visible.next_offset - visible.offset);
  assert.equal(result.details.output, output);
  assert.equal(visible.final_text.length, 90000);
});


const runtimeAPI = { getAllTools: () => [], getSettings: () => ({}),
  getResources: async () => ({ extensions: [], skills: [], mcp: null }) };

function fixture() {
  const tools = new Map(), handlers = new Map(), commands = new Map(), engines = [], factories = [];
  const entries = [], sent = [];
  class Engine {
    constructor(options) {
      this.options = options;
      this.tasks = [{ task_id: 'old', status: 'succeeded' }, { task_id: 't1', status: 'succeeded' }];
      engines.push(this);
    }
    async init() {}
    async close() { this.closed = true; }
    async query() { return this.tasks; }
    async pendingNotifications() { return []; }
    async start(input, profile, options) { this.started = { input, profile, options }; return this.result; }
    async append(id, content, options) { this.appended = { id, content, options }; return this.result; }
    async send(id, content, options) {
      if (this.tasks.some((task) => ['queued', 'running', 'stopping'].includes(task.status))) {
        throw new Error('Child is busy; task_send does not queue or steer');
      }
      this.sent = { id, content, options };
      return this.result;
    }
    async output(id, options) { this.read = { id, options }; return this.result; }
    async stop(id, reason) { this.stopped = { id, reason }; return this.result; }
  }
  const pi = {
    ...runtimeAPI,
    registerTool: (tool) => tools.set(tool.name, tool),
    on: (name, handler) => handlers.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
    getThinkingLevel: () => 'high', sendMessage: (...args) => sent.push(args),
    appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }),
  };
  const ctx = { cwd: '/project', hasUI: false, isIdle: () => true, model: { provider: 'fake', id: 'parent' },
    sessionManager: { getSessionId: () => 'parent-tools', getEntries: () => entries } };
  const profile = { name: 'worker', model: 'fake/model', thinking: 'high', instructions: '',
    tools: ['read'], extensions: [], skills: [], mcp: false, timeoutMs: 0 };
  const controller = registerTaskAgents(pi, { agentDir: '/agent-tools', Engine,
    configLoader: async () => ({ maxConcurrency: 4, roles: { worker: profile }, diagnostics: [] }),
    childFactory: (options) => { factories.push(options); return () => {}; },
  });
  return { tools, handlers, commands, engines, controller, ctx, factories, entries, sent,
    execute: (name, params, signal) => tools.get(name).execute('call-1', params, signal, undefined, ctx) };
}

test('task declaration and parent guidance describe foreground default and allow empty prompt', async () => {
  const f = fixture();
  try {
    const task = f.tools.get('task');
    assert.match(task.description, /Default is foreground/);
    assert.equal(task.parameters.properties.prompt.minLength, undefined);
    assert.equal(task.parameters.properties.description.maxLength, undefined);
    assert.match(task.parameters.properties.description.description, /1-50 Unicode/);
    const guidance = await f.handlers.get('before_agent_start')({ messageType: 'user', systemPrompt: 'base' }, f.ctx);
    assert.match(guidance.systemPrompt, /foreground by default/);
    assert.match(guidance.systemPrompt, /task_send/);
    assert.match(guidance.systemPrompt, /child session_id handle/);
    assert.match(guidance.systemPrompt, /rejects busy children \(queued\/running\/stopping\)/);
    assert.match(guidance.systemPrompt, /task_append.*running work is steered/);
    assert.match(f.tools.get('task_send').description, /task ID or the child session_id handle/);
    assert.match(f.tools.get('task_send').description, /Rejects busy children \(queued\/running\/stopping\)/);
    assert.match(f.tools.get('task_send').description, /never queues, steers or merges/);
    assert.match(f.tools.get('task_send').parameters.properties.task_id.description, /session_id handle/);
    f.engines[0].result = { task_id: 't1', status: 'succeeded', final_text: 'done' };
    const result = await f.execute('task', { agent_name: 'worker', description: 'title', prompt: '' });
    assert.equal(result.isError, undefined);
    assert.equal(f.engines[0].started.input.prompt, '');
    assert.equal(f.engines[0].started.input.run_in_background, undefined);
    assert.equal(f.factories.at(-1).inheritedModel, f.ctx.model);
    assert.equal(f.factories.at(-1).inheritedThinking, 'high');
  } finally { await f.controller.shutdown(); }
});

test('failed task replies retain execution facts and set isError without making failed output reads errors', async () => {
  const f = fixture();
  try {
    await f.controller.ensure(f.ctx);
    const facts = { task_id: 't1', session_id: 'child', agent_name: 'worker', status: 'failed', error: 'model failed',
      final_text: 'partial', usage: { output: 3 } };
    f.engines[0].result = facts;
    for (const name of ['task', 'task_send']) {
      const result = await f.execute(name, name === 'task'
        ? { agent_name: 'worker', description: 'title', prompt: '' } : { task_id: 't1', content: 'continue' });
      assert.equal(result.isError, true);
      if (name === 'task') {
        assert.deepEqual(result.details, { agent_name: 'worker', status: 'failed', task_id: 't1',
          sub_session_id: 'child', requested_agent_name: 'worker',
          final_text: 'partial', error_message: 'model failed' });
        assert.match(result.content[0].text, /^<task_error task_id="t1" session_id="child">/);
      } else {
        assert.deepEqual(result.details, facts);
        assert.match(result.content[0].text, /^<task_error/);
        assert.match(result.content[0].text, /partial/);
      }
    }
    const read = await f.execute('task_output', { task_id: 't1' });
    assert.equal(read.isError, undefined);
    f.engines[0].result = { ...facts, status: 'canceled', stopError: { code: 'TASK_STOP_FAILED', message: 'abort failed' } };
    const stop = await f.execute('task_stop', { task_id: 't1' });
    assert.equal(stop.isError, true);
    assert.equal(stop.details.stopError.code, 'TASK_STOP_FAILED');
    f.engines[0].result = { task_id: 't1', status: 'canceled' };
    const canceled = await f.execute('task_stop', { task_id: 't1' });
    assert.equal(canceled.isError, undefined);
  } finally { await f.controller.shutdown(); }
});

test('Task projects persisted run facts while query preserves only the source public lineage', async () => {
  const f = fixture();
  try {
    await f.controller.ensure(f.ctx);
    const facts = { task_id: 't1', session_id: 'child', status: 'succeeded', agent_name: 'request-label',
      requested_agent_name: 'stored-request', resolved_agent_name: 'worker', sub_turn_id: 'logical-turn-uuid',
      event_count: 0, final_text: 'all assistant text', output: 'tool trace must stay separate',
      notify_completion: false, description: 'bounded work' };
    f.engines[0].result = facts;
    const result = await f.execute('task', { agent_name: 'worker', description: 'title', prompt: 'work' });
    assert.deepEqual(result.details, { agent_name: 'worker', status: 'succeeded', task_id: 't1', sub_session_id: 'child',
      sub_turn_id: 'logical-turn-uuid', event_count: 0, requested_agent_name: 'stored-request', resolved_agent_name: 'worker',
      final_text: 'all assistant text' });
    assert.match(result.text, /requested_agent_name: stored-request/);
    assert.doesNotMatch(result.text, /tool trace must stay separate/);
    f.engines[0].tasks = [facts];
    const query = await f.execute('task_query', { task_id: 't1' });
    assert.deepEqual(query.details.task, { task_id: 't1', status: 'succeeded', kind: 'subagent', output: undefined,
      timing: undefined, session_id: 'child', parent_task_id: null, execution_mode: 'foreground', description: 'bounded work' });
    assert.equal(query.text, '- t1 [subagent/succeeded] bounded work (session_id=child execution_mode=foreground)');
    f.engines[0].result = { ...facts, final_text: undefined };
    const withoutFinal = await f.execute('task', { agent_name: 'worker', description: 'title', prompt: 'work' });
    assert.equal(Object.hasOwn(withoutFinal.details, 'final_text'), false);
    assert.doesNotMatch(withoutFinal.text, /tool trace must stay separate/);
  } finally { await f.controller.shutdown(); }
});

test('append forwards engine admission modes unchanged and send uses the synchronous engine API', async () => {
  const f = fixture();
  try {
    await f.controller.ensure(f.ctx);
    for (const mode of ['activated', 'steered', 'duplicate']) {
      f.engines[0].result = { task_id: 'next', session_id: 'same-child', status: 'running', mode, accepted: true };
      const reply = await f.execute('task_append', { task_id: 'old', content: 'continue' });
      assert.equal(reply.details.mode, mode);
      assert.equal(reply.details.accepted, true);
    }
    f.engines[0].result = { task_id: 'next', status: 'failed', mode: 'duplicate', accepted: true };
    const duplicate = await f.execute('task_append', { task_id: 'old', content: 'continue' });
    assert.equal(duplicate.isError, undefined);
    assert.equal(duplicate.details.mode, 'duplicate');
    const signal = new AbortController();
    f.engines[0].result = { task_id: 'reply', session_id: 'same-child', status: 'succeeded', final_text: 'answer' };
    const reply = await f.execute('task_send', { task_id: 'old', content: 'answer synchronously' }, signal.signal);
    assert.equal(reply.details.session_id, 'same-child');
    assert.equal(f.engines[0].sent.id, 'old');
    assert.equal(f.engines[0].sent.content, 'answer synchronously');
    assert.equal(f.engines[0].sent.options.requestId, 'call-1');
    signal.abort();
    assert.equal(f.engines[0].sent.options.signal.aborted, true);
  } finally { await f.controller.shutdown(); }
});

test('busy send failures do not admit or alter existing work; append remains the steering entry', async () => {
  const f = fixture();
  try {
    await f.controller.ensure(f.ctx);
    const engine = f.engines[0];
    for (const status of ['queued', 'running', 'stopping']) {
      const task = { task_id: 'existing', session_id: 'child', status, notification_pending: true };
      engine.tasks = [task];
      const before = structuredClone(task);
      const reply = await f.execute('task_send', { task_id: 'child', content: 'do not merge' });
      assert.equal(reply.isError, true);
      assert.equal(reply.details.task_id, 'child');
      assert.match(reply.details.error_message, /busy.*does not queue or steer/);
      assert.deepEqual(engine.tasks, [before]);
      assert.equal(engine.sent, undefined);
      assert.equal(engine.appended, undefined);
      assert.equal(engine.stopped, undefined);
      assert.equal(f.sent.length, 0);
    }
    engine.tasks[0].status = 'running';
    engine.result = { ...engine.tasks[0], mode: 'steered', accepted: true };
    const append = await f.execute('task_append', { task_id: 'existing', content: 'steer this work' });
    assert.equal(append.isError, undefined);
    assert.equal(append.details.mode, 'steered');
    assert.equal(engine.appended.content, 'steer this work');
  } finally { await f.controller.shutdown(); }
});

test('output accepts overlong waits, reports the cap and passes cancellation to the engine', async () => {
  const f = fixture();
  try {
    await f.controller.ensure(f.ctx);
    f.engines[0].result = { task_id: 't1', status: 'running', output: 'partial', next_offset: 7 };
    assert.equal(f.tools.get('task_output').parameters.properties.wait_ms.maximum, undefined);
    const signal = new AbortController();
    const reply = await f.execute('task_output', { task_id: 't1', wait_ms: 999999, offset: 0 }, signal.signal);
    assert.equal(f.engines[0].read.options.signal, signal.signal);
    assert.equal(f.engines[0].read.options.wait_ms, 30000);
    assert.equal(reply.details.effective_wait_ms, 30000);
    assert.equal(reply.details.wait_ms_clamped, true);
    assert.equal(reply.details.next_offset, 7);
    assert.match(reply.content[0].text, /^<task_output status="running">\n<task_output_cursor next_offset="7" \/>/);
    assert.match(reply.content[0].text, /partial\n<\/task_output>$/);
    assert.equal(reply.details.output, undefined);
  } finally { await f.controller.shutdown(); }
});

test('public control misses and append boundary failures use the upstream envelopes', async () => {
  const f = fixture();
  try {
    for (const name of ['task_query', 'task_output', 'task_stop']) {
      const reply = await f.execute(name, { task_id: 'missing', wait_ms: 90000 });
      assert.equal(reply.isError, true);
      assert.equal(reply.text, '<task_error>Local background task not found: missing</task_error>');
      assert.deepEqual(reply.details, { task_id: 'missing', status: 'not_found',
        ...(name === 'task_output' ? { effective_wait_ms: 30000, wait_ms_clamped: true } : {}) });
    }
    const cases = [
      [{ task_id: ' ', content: 'content' }, 'INVALID_ARGUMENT', 400, 'task_append requires a task_id.'],
      [{ task_id: 't1', content: ' ' }, 'INVALID_ARGUMENT', 400, 'task_append content must not be empty after trimming.'],
      [{ task_id: 'missing', content: 'content' }, 'TASK_NOT_FOUND', 404, 'Local background task not found: missing'],
    ];
    for (const [params, code, status, message] of cases) {
      const result = await f.execute('task_append', params);
      assert.equal(result.isError, true);
      assert.deepEqual(result.details, { task_id: params.task_id.trim(), code, status, accepted: false, error_message: message });
    }
    const signal = new AbortController();
    signal.abort();
    const aborted = await f.execute('task_append', { task_id: 't1', content: 'content' }, signal.signal);
    assert.equal(aborted.details.code, 'TASK_APPEND_ABORTED');
    assert.equal(aborted.details.status, 409);
    f.engines[0].append = async () => { throw new Error('unclassified storage failure'); };
    await assert.rejects(f.execute('task_append', { task_id: 't1', content: 'content' }), /unclassified storage failure/);
    const outputSchema = f.tools.get('task_output').parameters;
    assert.equal(Object.hasOwn(outputSchema.properties, 'limit_bytes'), false);
    assert.equal(outputSchema.additionalProperties, undefined);
    f.engines[0].result = { task_id: 't1', status: 'running', output: 'complete page', next_offset: 13 };
    await f.execute('task_output', { task_id: 't1', limit_bytes: 1 });
    assert.equal(Object.hasOwn(f.engines[0].read.options, 'limitBytes'), false);
  } finally { await f.controller.shutdown(); }
});

test('task schema accepts raw effort and prepares blank optional model/effort without coercing values', async () => {
  const f = fixture();
  try {
    const task = f.tools.get('task');
    assert.equal(task.parameters.properties.effort.type, 'string');
    assert.equal(task.parameters.properties.effort.minLength, 1);
    assert.equal(task.parameters.properties.effort.anyOf, undefined);
    const input = { agent_name: 'worker', description: 'title', prompt: 'work', model: '', effort: '  ' };
    assert.deepEqual(task.prepareArguments(input), { agent_name: 'worker', description: 'title', prompt: 'work' });
    assert.equal(input.model, '', 'argument preparation must not mutate raw input');
    let admitted;
    f.controller.start = async (params) => { admitted = params; return { task_id: 't1', status: 'succeeded', agent_name: 'worker' }; };
    await f.execute('task', { ...input, model: 'minimax/MiniMax-M3', effort: 'on' });
    assert.equal(admitted.effort, 'on');
    assert.equal(admitted.model, 'minimax/MiniMax-M3');
    await f.execute('task', input);
    assert.equal(Object.hasOwn(admitted, 'effort'), false);
    assert.equal(Object.hasOwn(admitted, 'model'), false);
  } finally { await f.controller.shutdown(); }
});

test('role discovery and slash roles are compact without leaking instructions or internal snapshots', async () => {
  const f = fixture();
  try {
    await f.controller.ensure(f.ctx);
    const result = await f.execute('task_agents', {});
    assert.equal(result.details.roles.worker.model, 'fake/model');
    assert.equal(result.details.roles.worker.thinking, 'high');
    assert.equal('instructions' in result.details.roles.worker, false);
    assert.equal('timeoutMs' in result.details.roles.worker, false);
    assert.equal(result.details.roles.worker.resources.mcp, 'off');
    await f.commands.get('tasks').handler('roles', f.ctx);
    assert.match(f.sent.at(-1)[0].content[0].text, /Role \| Model \| Thinking/);
    assert.doesNotMatch(f.sent.at(-1)[0].content[0].text, /instructions|timeoutMs/);
    await f.commands.get('tasks').handler('list', f.ctx);
    assert.match(f.sent.at(-1)[0].content[0].text, /\[subagent\/succeeded\]/);
  } finally { await f.controller.shutdown(); }
});

test('coded admission failures remain structured error results', async () => {
  const f = fixture();
  try {
    await f.controller.ensure(f.ctx);
    for (const [code, status] of [['INVALID_ARGUMENT', 400], ['TASK_APPEND_REJECTED', 409], ['TASK_APPEND_UNAVAILABLE', 503]]) {
      f.engines[0].append = async () => { throw Object.assign(new Error('source-owned admission failure'), { code, status }); };
      const reply = await f.execute('task_append', { task_id: 't1', content: 'valid input, adapter rejects' });
      assert.equal(reply.isError, true);
      assert.deepEqual(reply.details, { task_id: 't1', code, status,
        accepted: false, error_message: 'source-owned admission failure' });
    }
  } finally { await f.controller.shutdown(); }
});

test('real engine adapter waits by default, continues the same child and enforces owner isolation offline', async () => {
  const { mkdir, mkdtemp } = await import('node:fs/promises');
  const root = new URL('../artifacts/extension-tests/', import.meta.url);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const agentDir = await mkdtemp(new URL('adapter-', root).pathname);
  const tools = new Map(), children = [], sent = [];
  let release, entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const pi = { ...runtimeAPI, registerTool: (tool) => tools.set(tool.name, tool), on() {}, registerCommand() {},
    getThinkingLevel: () => 'high', appendEntry() {}, sendMessage: (...args) => sent.push(args) };
  const profile = { name: 'worker', instructions: '', tools: ['read'], timeoutMs: 0 };
  const controller = registerTaskAgents(pi, { agentDir,
    configLoader: async () => ({ maxConcurrency: 4, roles: { worker: profile }, diagnostics: [] }),
    childFactory: () => async ({ sessionPath }) => {
      const child = { sessionPath, prompts: [], turns: [],
        async prompt(text, options = {}) {
          this.prompts.push(text);
          this.turns.push(options.turnId);
          if (this.prompts.length === 1) {
            entered();
            return new Promise((resolve) => { release = resolve; });
          }
          return { text: `reply ${this.prompts.length}`, eventCount: 0, subTurnId: options.turnId, resolvedAgentName: 'worker' };
        }, async steer() {}, async abort() { release?.({ text: 'aborted' }); }, async dispose() {},
      };
      children.push(child);
      return child;
    },
  });
  const ctx = { cwd: agentDir, hasUI: false, model: { provider: 'fake', id: 'current' },
    sessionManager: { getSessionId: () => 'actual-parent', getEntries: () => [] } };
  const execute = (name, params, context = ctx) => tools.get(name).execute('call-' + name, params, undefined, undefined, context);
  try {
    let settled = false;
    const first = execute('task', { agent_name: 'worker', description: '  Unicode 😀 title  ', prompt: 'first' })
      .then((result) => { settled = true; return result; });
    await started;
    assert.equal(settled, false);
    release({ text: 'initial answer', eventCount: 0, subTurnId: children[0].turns[0], resolvedAgentName: 'worker' });
    const result = await first;
    assert.equal(result.details.status, 'succeeded');
    const stored = await controller.engine.query({ task_id: result.details.task_id });
    assert.equal(stored.description, 'Unicode 😀 title');
    assert.equal(result.details.description, undefined);
    assert.equal(result.details.final_text, 'initial answer');
    assert.equal(result.details.requested_agent_name, 'worker');
    assert.equal(result.details.resolved_agent_name, 'worker');
    assert.equal(result.details.event_count, 0);
    assert.equal(result.details.sub_turn_id, children[0].turns[0]);
    assert.equal(result.details.sub_turn_id, `turn_task_bg_${result.details.task_id}`);
    assert.notEqual(result.details.sub_turn_id, result.details.sub_session_id);
    assert.equal(stored.sub_turn_id, result.details.sub_turn_id);
    assert.equal(stored.event_count, 0);
    const continued = await execute('task_send', { task_id: result.details.task_id, content: 'second' });
    assert.equal(continued.details.status, 'succeeded');
    assert.equal(continued.details.session_id, result.details.sub_session_id);
    assert.equal(continued.details.final_text, 'reply 2');
    assert.notEqual(continued.details.sub_turn_id, result.details.sub_turn_id);
    assert.equal(continued.details.event_count, 0);
    assert.equal(children.length, 1);
    assert.deepEqual(children[0].prompts, ['first', 'second']);
    const sessionReply = await tools.get('task_send').execute('send-session-handle',
      { task_id: result.details.sub_session_id, content: 'third' }, undefined, undefined, ctx);
    assert.equal(sessionReply.isError, undefined);
    assert.equal(sessionReply.details.session_id, result.details.sub_session_id);
    assert.equal(sessionReply.details.final_text, 'reply 3');
    assert.equal(children.length, 1);
    const other = { ...ctx, sessionManager: { getSessionId: () => 'other-parent', getEntries: () => [] } };
    for (const handle of [result.details.task_id, result.details.sub_session_id]) {
      const denied = await execute('task_send', { task_id: handle, content: 'intrusion' }, other);
      assert.equal(denied.isError, true);
      assert.match(denied.details.error_message, /Unknown task|owner|parent/i);
    }
    assert.deepEqual(children[0].prompts, ['first', 'second', 'third']);
    assert.equal(new Set(children[0].turns).size, 3);
    assert.equal(sent.length, 0);
  } finally { await controller.shutdown(); }
});

test('ordinary abort pauses notifications without stop-all; explicit stop-all remains available', async () => {
  const f = fixture();
  try {
    await f.controller.ensure(f.ctx);
    f.engines[0].tasks = [{ task_id: 'running', status: 'running' }];
    await f.handlers.get('agent_before_settle')({ outcome: 'aborted' }, f.ctx);
    await f.handlers.get('agent_settled')({ aborted: true }, f.ctx);
    assert.equal(f.engines[0].stopped, undefined);
    assert.equal(f.engines[0].tasks[0].status, 'running');
    assert.equal(f.entries.at(-1).data.paused, true);
    await f.commands.get('tasks').handler('stop-all', f.ctx);
    assert.deepEqual(f.engines[0].stopped, { id: 'running', reason: 'User requested stop-all' });
  } finally { await f.controller.shutdown(); }
});
