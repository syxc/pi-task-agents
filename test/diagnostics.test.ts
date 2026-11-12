import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { DiagnosticLog, redactDiagnosticText, type DiagnosticFields } from '../src/diagnostics.ts'

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'task-diagnostics-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, directory: join(root, 'task-agents', 'logs'), log: new DiagnosticLog(root) }
}

async function records(directory: string): Promise<Record<string, unknown>[]> {
  const files = (await readdir(directory)).filter((name) => name.endsWith('.jsonl'))
  const contents = await Promise.all(files.map((name) => readFile(join(directory, name), 'utf8')))
  return contents.flatMap((text) =>
    text
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  )
}

test('diagnostics redact error details and select only controlled fields with private permissions', async (t) => {
  const f = await fixture(t)
  const error = Object.assign(new Error('api_key=message-secret Bearer bearer-secret'), {
    code: 'password=code-secret',
    cause: { prompt: 'CAUSE_PRIVATE', env: 'ENV_PRIVATE' },
    output: 'OUTPUT_PRIVATE',
    stack:
      'Error: access_token=stack-secret\nhttps://user:url-secret@example.test\n' +
      [
        '-----BEGIN',
        'PRIVATE KEY-----',
        'synthetic-test-data',
        '-----END',
        'PRIVATE KEY-----'
      ].join(' ')
  })
  f.log.write('error', 'test_failure', {
    parent_id: 'parent',
    task_id: 'task',
    session_id: 'session',
    agent_name: 'worker',
    status: 'failed',
    tool_name: 'task',
    requested_count: 2,
    available_count: 1,
    rejected_skills: [{ name: 'disabled', reason: 'disabled_model_invocation' }],
    error,
    prompt: 'PROMPT_PRIVATE',
    output: 'OUTPUT_PRIVATE',
    tool_args: { path: 'ARGS_PRIVATE' },
    env: { key: 'ENV_PRIVATE' },
    unknown: 'UNKNOWN_PRIVATE'
  } as DiagnosticFields)
  const [record] = await records(f.directory)
  assert.equal(record?.event, 'test_failure')
  assert.equal(record?.pid, process.pid)
  assert.ok(typeof record?.timestamp === 'string' && Number.isFinite(Date.parse(record.timestamp)))
  assert.deepEqual(record?.error, {
    message: 'api_key=[redacted] Bearer [redacted]',
    code: 'password=[redacted]',
    stack: 'Error: access_token=[redacted]\nhttps://[redacted]@example.test\n[redacted]'
  })
  const serialized = JSON.stringify(record)
  assert.doesNotMatch(
    serialized,
    /message-secret|bearer-secret|code-secret|stack-secret|url-secret|PRIVATE/
  )
  assert.deepEqual(record?.rejected_skills, [
    { name: 'disabled', reason: 'disabled_model_invocation' }
  ])
  assert.equal((await stat(join(f.root, 'task-agents'))).mode & 0o777, 0o700)
  assert.equal((await stat(f.directory)).mode & 0o777, 0o700)
  const [file] = await readdir(f.directory)
  assert.equal((await stat(join(f.directory, file!))).mode & 0o777, 0o600)
})

test('quoted credentials are fully redacted before error text is bounded', async (t) => {
  const f = await fixture(t)
  f.log.write('error', 'quoted_credentials', {
    error: {
      message: 'authorization="two word credential" token=synthetic-token',
      code: 42,
      stack: "password='multiple words' " + 'x'.repeat(20000)
    }
  })
  const [record] = await records(f.directory)
  const error = record?.error as { message: string; code: number; stack: string }
  assert.equal(error.message, 'authorization=[redacted] token=[redacted]')
  assert.equal(error.code, 42)
  assert.ok(error.stack.startsWith('password=[redacted] '))
  assert.equal(error.stack.length, 8192)
})

test('escaped quoted credentials are fully redacted in memory and persisted JSONL', async (t) => {
  const f = await fixture(t)
  const cases = [
    [JSON.stringify({ password: 'prefix"tail-secret-credential' }), '{"password":[redacted]}'],
    [JSON.stringify({ api_key: 'prefix\\"tail-secret-credential' }), '{"api_key":[redacted]}'],
    [
      JSON.stringify({ authorization: 'prefix\\\\tail-secret-credential' }),
      '{"authorization":[redacted]}'
    ],
    ["secret='prefix\\'tail-secret-credential'", 'secret=[redacted]'],
    ["password='prefix\\\\\\'tail-secret-credential'", 'password=[redacted]'],
    ["access_token='prefix\\tail-secret-credential'", 'access_token=[redacted]'],
    [
      JSON.stringify({ password: 'prefix\\"' + 'x'.repeat(20000) + 'tail-secret-credential' }) +
        ' visible-after-credential',
      '{"password":[redacted]} visible-after-credential'
    ]
  ] as const
  for (const [input, expected] of cases) {
    assert.equal(redactDiagnosticText(input), expected)
    f.log.write('error', 'escaped_credentials', { error: { message: input, stack: input } })
  }
  const persisted = await records(f.directory)
  assert.deepEqual(
    persisted.map((record) => record.error),
    cases.map(([, expected]) => ({ message: expected, stack: expected }))
  )
  const files = await readdir(f.directory)
  const raw = await Promise.all(files.map((name) => readFile(join(f.directory, name), 'utf8')))
  assert.doesNotMatch(raw.join(''), /prefix|tail-secret-credential/)
})

test('non-HTTP URI credentials disappear from persisted task identifiers and errors', async (t) => {
  const f = await fixture(t)
  const cases = [
    [
      'postgresql://audit_user:synthetic-password@db.invalid/prod',
      'postgresql://[redacted]@db.invalid/prod'
    ],
    ['redis://cache_user:cache:credential@cache.invalid/0', 'redis://[redacted]@cache.invalid/0'],
    ['git+ssh://git_user:git-credential@git.invalid/repo', 'git+ssh://[redacted]@git.invalid/repo']
  ] as const
  for (const [input] of cases) {
    f.log.write('error', 'task_not_found', {
      task_id: input,
      error: { code: 'TASK_NOT_FOUND', message: 'Task not found: ' + input }
    })
  }
  const files = await readdir(f.directory)
  const raw = await Promise.all(files.map((name) => readFile(join(f.directory, name), 'utf8')))
  for (const [input] of cases) {
    assert.ok(!raw.join('').includes(decodeURIComponent(new URL(input).password)))
  }
  const persisted = await records(f.directory)
  assert.deepEqual(
    persisted.map((record) => record.task_id),
    cases.map(([, expected]) => expected)
  )
  assert.deepEqual(
    persisted.map((record) => record.error),
    cases.map(([, expected]) => ({
      code: 'TASK_NOT_FOUND',
      message: 'Task not found: ' + expected
    }))
  )
})

test('long URLs without userinfo finish within a hard subprocess timeout', async (t) => {
  const f = await fixture(t)
  const moduleUrl = new URL('../src/diagnostics.ts', import.meta.url).href
  const source = [
    "import assert from 'node:assert/strict';",
    'import { DiagnosticLog, redactDiagnosticText } from ' + JSON.stringify(moduleUrl) + ';',
    "const input = 'https://' + ':'.repeat(100000);",
    'assert.equal(redactDiagnosticText(input), input);',
    'for (const scheme of ["postgresql", "redis", "a".repeat(100000)]) { const uri = scheme + "://" + ":".repeat(100000); assert.equal(redactDiagnosticText(uri), uri); }',
    "assert.equal(redactDiagnosticText('https://user:pass:word@example.test/path'), 'https://[redacted]@example.test/path');",
    'new DiagnosticLog(' +
      JSON.stringify(f.root) +
      ").write('error', 'long_url', { error: input });"
  ].join('\n')
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    timeout: 4000,
    killSignal: 'SIGKILL',
    encoding: 'utf8'
  })
  assert.ifError(child.error)
  assert.equal(child.signal, null)
  assert.equal(child.status, 0, child.stderr)
  assert.deepEqual((await records(f.directory))[0]?.error, {
    message: ('https://' + ':'.repeat(100000)).slice(0, 4096)
  })
})

test('daily diagnostics rotate without truncating and only clean expired owned files', async (t) => {
  const f = await fixture(t)
  await mkdir(f.directory, { recursive: true })
  const day = new Date().toISOString().slice(0, 10)
  const expired = new Date(Date.now() - 8 * 86400000).toISOString().slice(0, 10)
  const recent = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10)
  await Promise.all([
    writeFile(join(f.directory, `${day}.0.jsonl`), Buffer.alloc(1024 * 1024, 32)),
    writeFile(join(f.directory, `${expired}.0.jsonl`), 'old'),
    writeFile(join(f.directory, `${recent}.0.jsonl`), 'recent'),
    writeFile(join(f.directory, `${expired}.notes.jsonl`), 'unrelated')
  ])
  f.log.write('warning', 'rotated', {})
  assert.equal((await stat(join(f.directory, `${day}.0.jsonl`))).size, 1024 * 1024)
  assert.match(await readFile(join(f.directory, `${day}.1.jsonl`), 'utf8'), /rotated/)
  assert.ok(!(await readdir(f.directory)).includes(`${expired}.0.jsonl`))
  assert.equal(await readFile(join(f.directory, `${recent}.0.jsonl`), 'utf8'), 'recent')
  assert.equal(await readFile(join(f.directory, `${expired}.notes.jsonl`), 'utf8'), 'unrelated')
  await Promise.all(
    [1, 2, 3].map((index) =>
      writeFile(join(f.directory, `${day}.${index}.jsonl`), Buffer.alloc(1024 * 1024, 32))
    )
  )
  f.log.write('error', 'daily_cap', {})
  const today = (await readdir(f.directory)).filter((name) => name.startsWith(day))
  assert.equal(today.length, 4)
  const sizes = await Promise.all(today.map((name) => stat(join(f.directory, name))))
  assert.ok(sizes.every((entry) => entry.size === 1024 * 1024))
})

test('independent processes append complete JSON lines through rotation', async (t) => {
  const f = await fixture(t)
  await mkdir(f.directory, { recursive: true })
  const day = new Date().toISOString().slice(0, 10)
  await writeFile(
    join(f.directory, `${day}.0.jsonl`),
    '{}\n'.repeat(Math.floor((1024 * 1024 - 400) / 3))
  )
  const moduleUrl = new URL('../src/diagnostics.ts', import.meta.url).href
  await Promise.all(
    Array.from(
      { length: 4 },
      (_, index) =>
        new Promise<void>((resolve, reject) => {
          const source = `import { DiagnosticLog } from ${JSON.stringify(moduleUrl)};
const log = new DiagnosticLog(${JSON.stringify(f.root)});
for (let i = 0; i < 100; i++) log.write('warning', 'concurrent', { task_id: ${JSON.stringify(String(index))} + ':' + i });`
          const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
            stdio: ['ignore', 'ignore', 'pipe']
          })
          let stderr = ''
          child.stderr.on('data', (chunk) => {
            stderr += chunk
          })
          child.once('error', reject)
          child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(stderr))))
        })
    )
  )
  const concurrent = (await records(f.directory)).filter((record) => record.event === 'concurrent')
  assert.equal(concurrent.length, 400)
  assert.equal(new Set(concurrent.map((record) => record.task_id)).size, 400)
  assert.ok((await readdir(f.directory)).includes(`${day}.1.jsonl`))
})

test('unwritable destinations and hostile error getters never escape diagnostics', async (t) => {
  const f = await fixture(t)
  await writeFile(join(f.root, 'task-agents'), 'blocked')
  assert.doesNotThrow(() => f.log.write('error', 'blocked', { error: new Error('failure') }))
  const valid = await fixture(t)
  const error = {
    get message() {
      throw new Error('hostile')
    }
  }
  assert.doesNotThrow(() => valid.log.write('error', 'hostile', { error }))
  valid.log.write('warning', 'still_works', {
    error: { message: 'safe', cause: { secret: 'PRIVATE' } }
  })
  assert.deepEqual((await records(valid.directory))[0]?.error, { message: 'safe' })
})
