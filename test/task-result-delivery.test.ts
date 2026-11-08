import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import * as sdk from '@earendil-works/pi-coding-agent'
import { registerTaskAgents } from '../src/extension.ts'
import { TaskEngine } from '../src/engine.ts'
import { RESULT_TYPE, type TaskController } from '../src/controller.ts'
import { isRecord } from '../src/guards.ts'
import { answer, deferred, fixture, profile, tool } from './pi-backend-test-helpers.ts'

const longReport =
  Array.from(
    { length: 600 },
    (_, index) => `EVIDENCE-${index.toString().padStart(4, '0')} 必需证据🙂\n`
  ).join('') + 'REQUIRED_FINAL_RISK: external validation is still missing.'

for (const [name, report] of [
  ['short', 'REQUIRED_RESULT: owned.ts passed. REQUIRED_RISK: no external validation.'],
  ['long', longReport]
]) {
  test(
    `native parent notification reads the complete ${name} child result through the owned tool channel`,
    { timeout: 20000 },
    async (t) => {
      const f = await fixture(t)
      const childEntered = deferred(),
        releaseChild = deferred()
      f.script(async () => {
        childEntered.resolve()
        await releaseChild.promise
        return answer(report)
      })
      let controller!: TaskController,
        parent!: sdk.AgentSession,
        taskId = '',
        requests = 0,
        offset = 0,
        received = ''
      let resolveFinished!: () => void, rejectFinished!: (error: unknown) => void
      const finished = new Promise<void>((resolve, reject) => {
        resolveFinished = resolve
        rejectFinished = reject
      })
      finished.catch(() => {})
      const parentRuntime = {
        ...f.runtime,
        streamSimple(_model: unknown, context: unknown) {
          const result = Promise.resolve().then(() => {
            requests++
            const modelContext = JSON.stringify(context)
            if (requests === 1) {
              return tool('task', {
                agent_name: 'worker',
                description: 'Owned result delivery',
                prompt: 'Return all required evidence and risks.',
                run_in_background: true
              })
            }
            if (requests === 2) {
              const receipt = parent.messages.findLast(
                (message) => message.role === 'toolResult' && message.toolName === 'task'
              )
              assert.ok(receipt && receipt.role === 'toolResult')
              const text = receipt.content
                .filter((part) => part.type === 'text')
                .map((part) => part.text)
                .join('\n')
              taskId = /task_id="([^"]+)"/.exec(text)?.[1] ?? ''
              assert.ok(taskId)
              return answer('INDEPENDENT_PARENT_WORK_FINISHED')
            }
            const notice = parent.messages.findLast(
              (message) => message.role === 'custom' && message.customType === RESULT_TYPE
            )
            assert.ok(notice && notice.role === 'custom')
            assert.equal(
              notice.display,
              false,
              'Native internal messages stay model-visible without a user-facing notice'
            )
            assert.match(String(notice.content), /Use task_output/)
            assert.equal(String(notice.content).includes('REQUIRED_RESULT'), false)
            assert.equal(String(notice.content).includes('EVIDENCE-0000'), false)
            assert.match(
              modelContext,
              /Use task_output/,
              'The hidden native notice must reach the model context'
            )
            if (requests === 3) {
              assert.doesNotMatch(
                modelContext,
                /REQUIRED_RESULT|EVIDENCE-0000/,
                'The full result is not passed through hidden metadata'
              )
              return tool('task_output', { task_id: taskId, offset: 0 })
            }
            const output = parent.messages.findLast(
              (message) => message.role === 'toolResult' && message.toolName === 'task_output'
            )
            assert.ok(output && output.role === 'toolResult')
            const text = output.content
              .filter((part) => part.type === 'text')
              .map((part) => part.text)
              .join('\n')
            const cursor = /next_offset="(\d+)" truncated="(true|false)"/.exec(text)
            assert.ok(cursor, 'The model-facing result must provide the next byte cursor')
            const next = Number(cursor[1])
            assert.ok(next > offset)
            const expected = Buffer.from(report).subarray(offset, next).toString('utf8')
            const start = text.indexOf(expected)
            assert.ok(
              start >= 0,
              'Every saved byte range must be present in the model-facing tool result'
            )
            received += text.slice(start, start + expected.length)
            offset = next
            if (cursor[2] === 'true') {
              return tool('task_output', { task_id: taskId, offset })
            }
            assert.equal(received, report)
            assert.match(
              modelContext,
              name === 'long' ? /REQUIRED_FINAL_RISK/ : /REQUIRED_RISK/,
              'The required risk must be in the actual provider context, not only in extension state'
            )
            return answer('PARENT_REQUIRED_FACTS_READ')
          })
          result.catch(rejectFinished)
          return {
            async *[Symbol.asyncIterator]() {
              const message = await result
              yield { type: 'done', reason: message.stopReason, message }
            },
            result: () => result
          }
        }
      }
      const settings = sdk.SettingsManager.inMemory(
        { compaction: { enabled: false }, retry: { enabled: false } },
        { projectTrusted: false }
      )
      const manager = sdk.SessionManager.create(f.cwd, join(f.root, 'parent'))
      const loader = new sdk.DefaultResourceLoader({
        cwd: f.cwd,
        agentDir: f.agentDir,
        settingsManager: settings,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        systemPromptOverride: () =>
          'This is an offline parent transport fixture. Read child results before reporting.',
        extensionFactories: [
          (pi) => {
            controller = registerTaskAgents(pi, {
              agentDir: f.agentDir,
              childFactory: () => f.create,
              configLoader: async () => ({
                cwd: f.cwd,
                agentDir: f.agentDir,
                maxConcurrency: 1,
                roles: { worker: profile },
                diagnostics: [],
                sources: []
              })
            })
          }
        ]
      })
      try {
        await loader.reload()
        assert.deepEqual(loader.getExtensions().errors, [])
        assert.ok(controller, 'The real Pi resource loader must register the Task extension')
        parent = (
          await sdk.createAgentSession({
            cwd: f.cwd,
            agentDir: f.agentDir,
            resourceLoader: loader,
            sessionManager: manager,
            settingsManager: settings,
            model: f.model as sdk.CreateAgentSessionOptions['model'],
            modelRuntime: parentRuntime as unknown as sdk.ModelRuntime,
            tools: ['task', 'task_output', 'task_query']
          })
        ).session
        parent.subscribe((event) => {
          if (event.type === 'agent_settled' && received === report) {
            resolveFinished()
          }
        })
        await parent.bindExtensions({
          mode: 'json',
          onError: (error) => rejectFinished(new Error(error.error)),
          abortHandler() {},
          shutdownHandler() {}
        })
        await parent.prompt(
          'Start the owned independent child task, then finish the current parent work.'
        )
        assert.ok(
          taskId,
          'The parent must receive a real background admission before waiting for its child'
        )
        assert.equal(requests, 2)
        await childEntered.promise
        releaseChild.resolve()
        await finished
        assert.equal(offset, Buffer.byteLength(report))
        const saved = await controller.engine!.output(taskId, {
          offset: 0,
          limitBytes: Buffer.byteLength(report)
        })
        assert.equal(saved.output, report)
        await controller.flush()
        assert.equal((await controller.engine!.pendingNotifications()).length, 0)
        const notices = manager
          .getBranch()
          .filter((entry) => entry.type === 'custom_message' && entry.customType === RESULT_TYPE)
        assert.equal(notices.length, 1)
        const notice = notices[0]
        assert.ok(isRecord(notice))
        const noticeDetails = notice.details
        assert.ok(
          isRecord(noticeDetails) && typeof noticeDetails.parent_id === 'string',
          'completion notice must carry details.parent_id'
        )
        assert.equal(noticeDetails.parent_id, manager.getSessionId())
        const persisted = (await readFile(manager.getSessionFile()!, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
        assert.equal(
          persisted.filter(
            (entry) => entry.type === 'custom_message' && entry.customType === RESULT_TYPE
          ).length,
          1
        )
        await controller.flush()
        assert.equal(
          manager
            .getBranch()
            .filter((entry) => entry.type === 'custom_message' && entry.customType === RESULT_TYPE)
            .length,
          1
        )
        assert.ok(requests >= 4)
        await controller.shutdown()
        const restored = await new TaskEngine({
          rootDir: join(f.agentDir, 'task-agents', 'sessions'),
          cwd: f.cwd,
          parentId: manager.getSessionId(),
          createChild: async () => {
            throw new Error('Recovery must not replay the child')
          }
        }).init()
        try {
          assert.equal((await restored.output(taskId, { offset: 0 })).output, report)
          assert.equal((await restored.pendingNotifications()).length, 0)
        } finally {
          await restored.close()
        }
      } finally {
        releaseChild.resolve()
        try {
          await controller?.shutdown()
        } finally {
          if (parent) {
            await parent.extensionRunner?.emit({ type: 'session_shutdown', reason: 'quit' })
            parent.dispose()
          }
        }
      }
    }
  )
}
