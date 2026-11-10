import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TaskOutputReads } from '../src/engine-output.ts'
import { bounded } from './bounded.ts'

test('abort after cursor commit does not discard the committed result', async () => {
  const reads = new TaskOutputReads(`cancel-committed-${process.pid}`)
  const controller = new AbortController()
  const result = await reads.automatic('task', controller.signal, async () => {
    queueMicrotask(() => queueMicrotask(() => controller.abort()))
    return { next_offset: 7 }
  })
  assert.equal(result.next_offset, 7)
  const next = await reads.automatic('task', undefined, async (offset) => ({ next_offset: offset }))
  assert.equal(next.next_offset, 7)
})

test('aborting a queued automatic read returns promptly without overtaking its predecessor', async () => {
  const reads = new TaskOutputReads(`cancel-queued-${process.pid}`)
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const offsets: number[] = []
  const first = reads.automatic('task', undefined, async (offset) => {
    offsets.push(offset)
    await gate
    return { next_offset: 1 }
  })
  const controller = new AbortController()
  const canceled = reads.automatic('task', controller.signal, async (offset) => {
    offsets.push(offset)
    return { next_offset: 99 }
  })
  const last = reads.automatic('task', undefined, async (offset) => {
    offsets.push(offset)
    return { next_offset: 2 }
  })
  controller.abort()
  try {
    await assert.rejects(bounded(canceled, 500, 'Cancellation did not settle'), {
      name: 'AbortError'
    })
    assert.deepEqual(offsets, [0])
  } finally {
    release()
  }
  assert.equal((await first).next_offset, 1)
  assert.equal((await last).next_offset, 2)
  assert.deepEqual(offsets, [0, 1])
})
