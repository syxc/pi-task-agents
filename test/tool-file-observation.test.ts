import assert from 'node:assert/strict'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { SettingsManager } from '@earendil-works/pi-coding-agent'
import { answer, deferred, fixture, tool } from './pi-backend-test-helpers.ts'

for (const name of ['worker', 'mavis']) {
  test(`${name} captures native write targets and reports actual changes without a model verdict`, async (t) => {
    const f = await fixture(t)
    f.script((step) =>
      step === 1
        ? tool('write', { path: 'owned.txt', content: 'owned evidence' })
        : answer('Implemented')
    )
    const child = await f.child({ name, tools: ['write'] })
    const result = await child.prompt('Write only the owned fixture target.')
    assert.equal(await readFile(join(f.cwd, 'owned.txt'), 'utf8'), 'owned evidence')
    assert.equal(
      result.verification?.fileChange,
      'change_observed',
      JSON.stringify(result.verification)
    )
    assert.deepEqual(result.verification?.changedFiles, ['owned.txt'])
    assert.equal(result.verification?.modelVerdict, undefined)
  })
}

for (const writer of ['write', 'edit']) {
  for (const spelling of ['at', 'spaces', 'unicode', 'file-url', 'tilde']) {
    test(`${writer} observes the actual native ${spelling} path rather than a different literal filename`, async (t) => {
      const f = await fixture(t)
      const name =
        spelling === 'spaces'
          ? ' edge.txt '
          : spelling === 'unicode'
            ? 'unicode name.txt'
            : 'owned.txt'
      const path =
        spelling === 'at'
          ? '@owned.txt'
          : spelling === 'unicode'
            ? 'unicode\u00A0name.txt'
            : spelling === 'file-url'
              ? pathToFileURL(join(f.cwd, name)).href
              : spelling === 'tilde'
                ? `~/${relative(homedir(), join(f.cwd, name))}`
                : name
      if (writer === 'edit') {
        await writeFile(join(f.cwd, name), 'original')
      }
      f.script((step) =>
        step === 1
          ? tool(
              writer,
              writer === 'write'
                ? { path, content: 'modified' }
                : { path, oldText: 'original', newText: 'modified' }
            )
          : answer('done')
      )
      const child = await f.child({ name: 'worker', tools: [writer] })
      const result = await child.prompt('Modify only the assigned owned fixture path.')
      assert.equal(await readFile(join(f.cwd, name), 'utf8'), 'modified')
      assert.equal(result.verification?.fileChange, 'change_observed')
      assert.deepEqual(result.verification?.changedFiles, [name])
    })
  }
}

test('a native file URL outside the workspace remains out of observation scope', async (t) => {
  const f = await fixture(t),
    target = join(f.root, 'outside.txt')
  f.script((step) =>
    step === 1
      ? tool('write', { path: pathToFileURL(target).href, content: 'owned outside bytes' })
      : answer('done')
  )
  const child = await f.child({ name: 'worker', tools: ['write'] })
  const result = await child.prompt('Write only the explicitly owned outside-workspace fixture.')
  assert.equal(await readFile(target, 'utf8'), 'owned outside bytes')
  assert.equal(result.verification?.fileChange, 'uncertain')
  assert.deepEqual(result.verification?.changedFiles, [])
})

for (const { name, command, file, content, prompt } of [
  {
    name: 'literal Bash paths with edge spaces preserve observed writes without a false clean result',
    command: "printf evidence > ' edge.txt '",
    file: ' edge.txt ',
    content: 'evidence',
    prompt: 'Write only the assigned path, including its literal spaces.'
  },
  {
    name: 'spaces in Bash payload do not make an exact plain target ambiguous',
    command: "printf ' payload.txt ' > payload.txt",
    file: 'payload.txt',
    content: ' payload.txt ',
    prompt: 'Write only payload.txt.'
  },
  {
    name: 'parent traversal in Bash payload does not make an exact write target ambiguous',
    command: "printf 'alias/../owned.txt' > payload.txt",
    file: 'payload.txt',
    content: 'alias/../owned.txt',
    prompt: 'Write only payload.txt.'
  }
]) {
  test(name, async (t) => {
    const f = await fixture(t)
    f.script((step) => (step === 1 ? tool('bash', { command }) : answer('done')))
    const child = await f.child({ name: 'worker', tools: ['bash'] })
    const result = await child.prompt(prompt)
    assert.equal(await readFile(join(f.cwd, file), 'utf8'), content)
    assert.equal(result.verification?.fileChange, 'change_observed')
    assert.deepEqual(result.verification?.changedFiles, [file])
  })
}

for (const managed of [false, true]) {
  for (const outside of [false, true]) {
    test(`${managed ? 'managed' : 'foreground'} native Bash observes an effective prefix moving writes ${outside ? 'outside' : 'within'} the workspace`, async (t) => {
      let prefix = ''
      const f = await fixture(t, {
        sdk: {
          SettingsManager: {
            create: SettingsManager.create,
            fromStorage: SettingsManager.fromStorage,
            inMemory: (settings: object, options: Parameters<typeof SettingsManager.inMemory>[1]) =>
              SettingsManager.inMemory({ ...settings, shellCommandPrefix: prefix }, options)
          }
        }
      })
      const directory = join(outside ? f.root : f.cwd, 'nested')
      await mkdir(directory)
      prefix = `cd ${JSON.stringify(directory)}`
      f.script((step) => {
        if (step === 1) {
          return tool(managed ? 'bash_task' : 'bash', {
            ...(managed ? { action: 'start' } : {}),
            command: 'printf evidence > owned.txt'
          })
        }
        if (managed && step === 3) {
          const receipt = f
            .session()
            .messages.find(
              (message) => message.role === 'toolResult' && message.toolName === 'bash_task'
            )
          assert.ok(receipt && receipt.role === 'toolResult')
          const { command_id } = JSON.parse(
            receipt.content
              .filter((part) => part.type === 'text')
              .map((part) => part.text)
              .join('')
          )
          return tool('bash_task', { action: 'output', command_id })
        }
        return answer('done')
      })
      const child = await f.child({ name: 'worker', tools: ['bash'] })
      const result = await child.prompt('Run only the assigned native command.')
      assert.equal(await readFile(join(directory, 'owned.txt'), 'utf8'), 'evidence')
      assert.equal(result.verification?.fileChange, 'uncertain')
      if (outside) {
        assert.deepEqual(result.verification?.changedFiles, [])
      } else {
        assert.ok(result.verification?.changedFiles?.includes('nested/owned.txt'))
      }
    })
  }
}

for (const managed of [false, true]) {
  test(`${managed ? 'managed' : 'foreground'} Bash parent traversal cannot erase a symbolic directory from observation`, async (t) => {
    const f = await fixture(t),
      base = join(managed ? f.cwd : f.root, 'other')
    await mkdir(join(base, 'nested'), { recursive: true })
    await symlink(join(base, 'nested'), join(f.cwd, 'alias'), 'dir')
    f.script((step) => {
      if (step === 1) {
        return tool(managed ? 'bash_task' : 'bash', {
          ...(managed ? { action: 'start' } : {}),
          command: 'printf evidence > alias/../owned.txt'
        })
      }
      if (managed && step === 3) {
        const receipt = f
          .session()
          .messages.find(
            (message) => message.role === 'toolResult' && message.toolName === 'bash_task'
          )
        assert.ok(receipt && receipt.role === 'toolResult')
        const { command_id } = JSON.parse(
          receipt.content
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('')
        )
        return tool('bash_task', { action: 'output', command_id })
      }
      return answer('done')
    })
    const child = await f.child({ name: 'worker', tools: ['bash'] })
    const result = await child.prompt('Run only the assigned owned fixture command.')
    assert.equal(await readFile(join(base, 'owned.txt'), 'utf8'), 'evidence')
    assert.equal(result.verification?.fileChange, 'uncertain')
    if (managed) {
      assert.ok(result.verification?.changedFiles?.includes('other/owned.txt'))
    } else {
      assert.deepEqual(result.verification?.changedFiles, [])
    }
  })
}

test('native file tools resolve parent traversal before filesystem access, unlike Bash', async (t) => {
  const f = await fixture(t),
    target = join(f.root, 'other', 'nested')
  await mkdir(target, { recursive: true })
  await symlink(target, join(f.cwd, 'alias'), 'dir')
  f.script((step) =>
    step === 1
      ? tool('write', { path: 'alias/../owned.txt', content: 'native bytes' })
      : answer('done')
  )
  const child = await f.child({ name: 'worker', tools: ['write'] })
  const result = await child.prompt('Write only the native resolved fixture path.')
  assert.equal(await readFile(join(f.cwd, 'owned.txt'), 'utf8'), 'native bytes')
  assert.equal(result.verification?.fileChange, 'change_observed')
  assert.deepEqual(result.verification?.changedFiles, ['owned.txt'])
})

test('dynamic Bash targets preserve uncertainty while retaining observed changed paths', async (t) => {
  const f = await fixture(t)
  f.script((step) =>
    step === 1
      ? tool('bash', { command: 'name=owned.txt; printf evidence > "$name"' })
      : answer('done')
  )
  const child = await f.child({ tools: ['bash'] })
  const result = await child.prompt('Run only the owned fixture command.')
  assert.equal(result.verification?.fileChange, 'uncertain')
  assert.ok(result.verification?.changedFiles?.includes('owned.txt'))
  assert.ok(result.verification?.observationNotes.some((note) => note.includes('ambiguous')))
})

test(
  'nested codemode write is observed through the native tool lifecycle',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t, { isCodemodeEnabled: () => true })
    f.script((step) =>
      step === 1
        ? tool('codemode', {
            code: 'await tools.write({path:"nested.txt",content:"nested evidence"});text("saved");'
          })
        : answer('done')
    )
    const child = await f.child({ tools: ['write'] })
    const result = await child.prompt('Use the enabled codemode only for the owned fixture.')
    assert.equal(await readFile(join(f.cwd, 'nested.txt'), 'utf8'), 'nested evidence')
    assert.equal(result.verification?.fileChange, 'change_observed')
    assert.deepEqual(result.verification?.changedFiles, ['nested.txt'])
  }
)

test('an excluded or out-of-workspace write does not become a clean-workspace claim', async (t) => {
  const f = await fixture(t)
  const path = join(f.root, 'owned-outside-workspace.txt')
  f.script((step) =>
    step === 1 ? tool('write', { path, content: 'owned outside evidence' }) : answer('done')
  )
  const child = await f.child({ tools: ['write'] })
  const result = await child.prompt('Write only the explicitly owned outside-workspace fixture.')
  assert.equal(await readFile(path, 'utf8'), 'owned outside evidence')
  assert.equal(result.verification?.fileChange, 'uncertain')
  assert.ok(!result.verification?.changedFiles?.includes(path))
})

test('a denied writer never reports its intended target as an observed change', async (t) => {
  const f = await fixture(t)
  const extension = join(f.root, 'deny-owned-write.mjs')
  await writeFile(
    extension,
    `export default pi => pi.on('tool_call', event => event.toolName === 'write'
    ? {block:true,reason:'Owned denial fixture'} : undefined);`
  )
  f.script((step) =>
    step === 1 ? tool('write', { path: 'denied.txt', content: 'not written' }) : answer('denied')
  )
  const child = await f.child({ tools: ['write'], extensions: [extension] })
  const result = await child.prompt('Attempt only the owned denied target.')
  await assert.rejects(readFile(join(f.cwd, 'denied.txt')), /ENOENT/)
  assert.notEqual(result.verification?.fileChange, 'change_observed')
  assert.deepEqual(result.verification?.changedFiles, [])
})

test('a failed editor reports uncertainty without changing execution outcome or inventing a verdict', async (t) => {
  const f = await fixture(t)
  await writeFile(join(f.cwd, 'owned.txt'), 'original')
  f.script((step) =>
    step === 1
      ? tool('edit', { path: 'owned.txt', oldText: 'missing', newText: 'never written' })
      : answer('VERDICT: PASS')
  )
  const child = await f.child({ tools: ['edit'] })
  const result = await child.prompt('Attempt only the owned editor fixture.')
  assert.equal(await readFile(join(f.cwd, 'owned.txt'), 'utf8'), 'original')
  assert.equal(result.outcome?.kind === 'returned' ? result.outcome.status : undefined, 'succeeded')
  assert.equal(result.verification?.fileChange, 'uncertain')
  assert.equal(result.verification?.modelVerdict, undefined)
  assert.ok(result.verification?.observationNotes.includes('failed_tool_capture'))
})

test(
  'aborted native Bash retains partial write evidence without claiming a clean workspace',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t)
    f.script((step) =>
      step === 1
        ? tool('bash', {
            command: 'printf evidence > owned.txt; printf OWNED_ABORT_READY; sleep 30'
          })
        : answer('not reached')
    )
    const child = await f.child({ tools: ['bash'] })
    const ready = deferred()
    const unsubscribe = f.session().subscribe((event) => {
      if (
        event.type === 'tool_execution_update' &&
        JSON.stringify(event.partialResult).includes('OWNED_ABORT_READY')
      ) {
        ready.resolve()
      }
    })
    const result = child
      .prompt('Run only the owned abort fixture.')
      .catch((error) => error.partialResult)
    try {
      await ready.promise
      await child.abort()
      const partial = await result
      assert.equal(await readFile(join(f.cwd, 'owned.txt'), 'utf8'), 'evidence')
      assert.equal(partial.outcome.status, 'aborted')
      assert.equal(partial.verification.fileChange, 'uncertain')
      assert.ok(partial.verification.changedFiles.includes('owned.txt'))
    } finally {
      unsubscribe()
    }
  }
)

test('first-before and last-after target facts do not attribute an unrelated concurrent file', async (t) => {
  const f = await fixture(t)
  await writeFile(join(f.cwd, 'owned.txt'), 'initial')
  f.script(async (step) => {
    if (step === 1) {
      return tool('write', { path: 'owned.txt', content: 'first' })
    }
    if (step === 2) {
      await writeFile(join(f.cwd, 'unrelated.txt'), 'external actor')
      return tool('write', { path: 'owned.txt', content: 'last' })
    }
    return answer('done')
  })
  const child = await f.child({ tools: ['write'] })
  const result = await child.prompt('Modify only owned.txt.')
  assert.equal(result.verification?.fileChange, 'change_observed')
  assert.deepEqual(result.verification?.changedFiles, ['owned.txt'])
})
