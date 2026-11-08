import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rename, rm, unlink, writeFile, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { CommandLogs } from '../src/command-journal.ts'
import { CommandOutput } from '../src/command-output.ts'

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'owned-command-output-')),
    id = 'bg_' + randomUUID()
  const logs = new CommandLogs(join(root, 'child.jsonl')),
    output = await CommandOutput.create(logs, id, () => {})
  const sources: string[] = []
  t.after(async () => {
    await output.close()
    /* oxlint-disable no-await-in-loop -- Finish owned file cleanup before removing the shared fixture. */
    for (const path of sources) {
      await unlink(path).catch(() => {})
    }
    /* oxlint-enable no-await-in-loop */
    await rm(root, { recursive: true, force: true })
  })
  return {
    root,
    id,
    logs,
    output,
    sources,
    async native(bytes: Buffer) {
      const path = join(tmpdir(), 'pi-bash-' + randomBytes(8).toString('hex') + '.log')
      sources.push(path)
      await writeFile(path, bytes, { mode: 0o600, flag: 'wx' })
      return path
    }
  }
}
const snapshot = (path: string) => ({
  content: [{ type: 'text', text: 'ALLOWED_PREVIEW' }],
  details: { fullOutputPath: path, truncation: { truncated: true } },
  structuredContent: { output: 'ALLOWED_PREVIEW', truncated: true }
})

test('a failed native FileHandle close retains explicit resource ownership until a successful retry', async (t) => {
  const f = await fixture(t),
    handle = [...(f.output as unknown as { handles: Set<FileHandle> }).handles][0]
  const close = handle.close.bind(handle)
  let blocked = true
  t.mock.method(handle, 'close', async () => {
    if (blocked) {
      throw new Error('CLOSE_UNCONFIRMED')
    }
    await close()
  })
  try {
    await assert.rejects(
      f.output.finish({ content: [{ type: 'text', text: 'complete bytes' }] }),
      /finalization/
    )
    assert.equal(f.output.hasOpenResources, true)
    assert.equal(f.output.incomplete, true)
    blocked = false
    await f.output.close()
    assert.equal(f.output.hasOpenResources, false)
  } finally {
    blocked = false
    await f.output.close()
  }
})

test('an initially unavailable native spool is retried after abort drops the final metadata', async (t) => {
  const f = await fixture(t),
    source = join(tmpdir(), 'pi-bash-' + randomBytes(8).toString('hex') + '.log')
  f.sources.push(source)
  f.output.update(snapshot(source))
  await (f.output as unknown as { opening?: Promise<void> }).opening
  const bytes = Buffer.from('complete native stdout\n'.repeat(5000))
  await writeFile(source, bytes, { mode: 0o600, flag: 'wx' })
  await f.output.finish({ content: [{ type: 'text', text: 'ALLOWED_PREVIEW\nCommand aborted' }] })
  assert.equal((await readFile(join(f.logs.root, f.id + '.log'))).equals(bytes), true)
  assert.equal(f.output.incomplete, false)
  assert.equal(f.output.hasOpenResources, false)
})

test('a missing truncated spool cannot become a complete result after metadata-free failure', async (t) => {
  const f = await fixture(t),
    source = join(tmpdir(), 'pi-bash-' + randomBytes(8).toString('hex') + '.log')
  f.output.update(snapshot(source))
  await (f.output as unknown as { opening?: Promise<void> }).opening
  await f.output.finish({ content: [{ type: 'text', text: 'ALLOWED_PREVIEW\nCommand timed out' }] })
  assert.equal(f.output.incomplete, true)
  assert.equal(f.output.hasOpenResources, false)
})

test('complete structured output can recover a missing spool without claiming data loss', async (t) => {
  const f = await fixture(t),
    source = join(tmpdir(), 'pi-bash-' + randomBytes(8).toString('hex') + '.log')
  f.output.update(snapshot(source))
  await (f.output as unknown as { opening?: Promise<void> }).opening
  await f.output.finish({
    content: [{ type: 'text', text: 'ALLOWED_PREVIEW' }],
    structuredContent: { output: 'complete captured output', truncated: false }
  })
  assert.equal(f.output.incomplete, false)
  assert.equal(await readFile(join(f.logs.root, f.id + '.log'), 'utf8'), 'complete captured output')
})

test('an undecodable native UTF-8 tail is retained on disk and explicitly marked incomplete', async (t) => {
  const f = await fixture(t),
    bytes = Buffer.concat([Buffer.alloc(100000, 'x'), Buffer.from([0xe4])])
  const source = await f.native(bytes)
  await f.output.finish(snapshot(source))
  assert.equal(f.output.incomplete, true)
  assert.equal(f.output.hasOpenResources, false)
  assert.deepEqual(await readFile(join(f.logs.root, f.id + '.log')), bytes)
  const tail = f.output.read(bytes.length - 1)
  assert.equal(tail.output, '')
  assert.equal(tail.next_offset, bytes.length - 1)
  assert.equal(tail.truncated, true)
})

test('a lossy native prefix keeps reads on the decoded log and marks the stream incomplete', async (t) => {
  const f = await fixture(t),
    source = await f.native(Buffer.from([0xe4]))
  f.output.update({
    content: [{ type: 'text', text: '\uFFFD' }],
    details: { fullOutputPath: source }
  })
  await (f.output as unknown as { opening?: Promise<void> }).opening
  await writeFile(source, Buffer.from([0xe4, 0x61, 0x62]))
  const first = f.output.read(0)
  assert.equal(first.output, '\uFFFD')
  assert.equal(first.next_offset, 3)
  assert.equal(f.output.incomplete, true)
  assert.equal(f.output.read(first.next_offset).output, '')
})

test('arbitrary output paths and file URIs never replace the already returned tool bytes', async (t) => {
  const f = await fixture(t),
    secret = join(f.root, 'unrelated-private.txt')
  await writeFile(secret, 'FORBIDDEN_PRIVATE_BYTES')
  const value = snapshot(secret)
  await f.output.finish({
    ...value,
    structuredContent: { ...value.structuredContent, full_output_path: 'file://' + secret }
  })
  assert.equal(f.output.incomplete, true)
  assert.equal(await readFile(join(f.logs.root, f.id + '.log'), 'utf8'), 'ALLOWED_PREVIEW')
  assert.equal(await readFile(secret, 'utf8'), 'FORBIDDEN_PRIVATE_BYTES')
})

test('final text that contradicts the streamed prefix marks the log incomplete', async (t) => {
  const f = await fixture(t)
  f.output.update({
    content: [{ type: 'text', text: 'streamed prefix' }],
    details: {}
  })
  await f.output.finish({
    content: [{ type: 'text', text: 'different final text' }],
    details: {}
  })
  assert.equal(f.output.incomplete, true)
  assert.equal(f.output.hasOpenResources, false)
  assert.equal(await readFile(join(f.logs.root, f.id + '.log'), 'utf8'), 'streamed prefix')
})

test('native source replacement uses the pinned FileHandle with bounded-copy fallback, never the replacement bytes', async (t) => {
  const f = await fixture(t),
    bytes = Buffer.from('original native output\n'.repeat(10000))
  const source = await f.native(bytes),
    original = source + '.original'
  f.sources.push(original)
  const value = snapshot(source)
  f.output.update(value)
  await (f.output as unknown as { opening?: Promise<void> }).opening
  await rename(source, original)
  await writeFile(source, 'FORBIDDEN_REPLACEMENT_BYTES', { flag: 'wx', mode: 0o600 })
  await f.output.finish(value)
  assert.equal(f.output.hasOpenResources, false)
  assert.equal(f.output.incomplete, false)
  assert.deepEqual(await readFile(join(f.logs.root, f.id + '.log')), bytes)
})

test('malformed bytes inside a native spool are reported when decoded, not silently replaced', async (t) => {
  const f = await fixture(t),
    bytes = Buffer.concat([
      Buffer.from('HEAD'),
      Buffer.from([0xf0, 0x90, 0x80]),
      Buffer.from('TAIL\n'),
      Buffer.alloc(100000, 'x')
    ])
  const source = await f.native(bytes)
  await f.output.finish(snapshot(source))
  const value = f.output.read(0)
  assert.match(value.output, /HEAD\uFFFDTAIL/)
  assert.equal(value.output_incomplete, true)
  assert.deepEqual(await readFile(join(f.logs.root, f.id + '.log')), bytes)
})
