import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import * as sdk from '@earendil-works/pi-coding-agent'
import { registerTaskAgents } from '../src/extension.ts'
import { TaskEngine } from '../src/engine.ts'
import type { TaskController } from '../src/controller.ts'
import { verificationText } from '../src/task-verification.ts'
import { OutputProjector, outputWait } from '../src/tool-result-control.ts'
import { answer, fixture, profile, tool } from './pi-backend-test-helpers.ts'

const longReport =
  Array.from(
    { length: 600 },
    (_, index) => `EVIDENCE-${index.toString().padStart(4, '0')} 必需证据🙂\n`
  ).join('') + 'REQUIRED_FINAL_RISK: external validation is still missing.'
test(
  'real SDK provider context preserves pages and reversible verification omission offline',
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t)
    const report = longReport.repeat(7)
    const verification = {
      modelVerdict: 'pass' as 'pass' | 'fail',
      fileChange: 'change_observed' as const,
      changedFiles: Array.from(
        { length: 200 },
        (_, index) => `src/owned-${index.toString().padStart(3, '0')}-${'evidence-'.repeat(8)}.ts`
      ),
      observationNotes: ['REQUIRED_VERIFICATION_RISK: best-effort observation, not a sandbox.']
    }
    const fullVerification = verificationText(verification)
    let currentVerification = verification
    class ChangingReportEngine extends TaskEngine {
      override async output(...args: Parameters<TaskEngine['output']>) {
        return { ...(await super.output(...args)), verification: currentVerification }
      }
    }
    let knownFingerprint = '',
      latestFingerprint = ''
    let controller!: TaskController,
      parent!: sdk.AgentSession,
      taskId = '',
      received = '',
      offset = 0
    let request = 0,
      firstPage = '',
      compactFirstPage = '',
      phase = 'paginate'
    const rereads = [
      { offset: 1 },
      { offset: 1, known: true },
      { offset: 1, known: true },
      { offset: 0, known: true },
      { offset: 0 },
      { offset: Buffer.byteLength(report) },
      { offset: 1, known: true, change: true },
      { offset: 1, known: true },
      { offset: 1, known: true, latest: true }
    ]
    let rereadIndex = 0
    f.script((_step, context) => {
      request++
      if (request === 1) {
        return tool('task', {
          agent_name: 'worker',
          description: 'Verification paging',
          prompt: 'Return the saved fixture.'
        })
      }
      if (request === 2) {
        const result = context.messages.findLast(
          (message) => message.role === 'toolResult' && message.toolName === 'task'
        )
        assert.ok(result && result.role === 'toolResult')
        taskId =
          /task_id="([^"]+)"/.exec(
            result.content
              .filter((part) => part.type === 'text')
              .map((part) => part.text)
              .join('\n')
          )?.[1] ?? ''
        assert.ok(taskId)
        return tool('task_output', { task_id: taskId, offset: 0 })
      }
      const result = context.messages.findLast(
        (message) => message.role === 'toolResult' && message.toolName === 'task_output'
      )
      assert.ok(result && result.role === 'toolResult')
      const text = result.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n')
      const cursor = /next_offset="(\d+)" truncated="(true|false)"/.exec(text)
      assert.ok(cursor, 'Cursor and truncation must reach the actual provider')
      assert.match(text, /^<task_output status="succeeded">/)
      const start = phase === 'paginate' ? offset : rereads[rereadIndex].offset
      const next = Number(cursor[1])
      const page = Buffer.from(report).subarray(start, next).toString('utf8')
      assert.ok(
        text.endsWith(`${page || '(no output yet)'}\n</task_output>`),
        'No saved page bytes may be hidden or changed'
      )
      assert.equal(cursor[2], String(next < Buffer.byteLength(report)))
      const fingerprint = /fingerprint="(sha256:[a-f0-9]{64})"/.exec(text)?.[1]
      assert.ok(fingerprint, 'The provider must receive a report identity')
      if (!knownFingerprint) {
        knownFingerprint = fingerprint
      }
      latestFingerprint = fingerprint
      const include =
        phase === 'paginate'
          ? offset === 0
          : !rereads[rereadIndex].known ||
            (currentVerification.modelVerdict === 'fail' && !rereads[rereadIndex].latest)
      if (include) {
        assert.ok(
          text.includes(verificationText(currentVerification)),
          'Full verification must be in provider content, not only details'
        )
        assert.doesNotMatch(text, /Verification text omitted/)
        if (currentVerification.modelVerdict === 'fail') {
          assert.match(text, /model_verdict: fail/)
          assert.notEqual(fingerprint, knownFingerprint)
        }
      } else {
        assert.doesNotMatch(text, /REQUIRED_VERIFICATION_RISK|changed_files:/)
        assert.match(text, /known_verification_fingerprint matches the current report/)
        assert.match(text, /Omit that argument.*any valid offset/)
        if (start === 0) {
          compactFirstPage = text
        }
      }
      const saved = parent.messages.findLast(
        (message) => message.role === 'toolResult' && message.toolName === 'task_output'
      )
      assert.ok(saved && saved.role === 'toolResult')
      assert.deepEqual(saved.details.verification, currentVerification)
      if (phase === 'paginate') {
        if (offset === 0) {
          firstPage = text
        }
        received += page
        offset = next
        if (cursor[2] === 'true') {
          return tool('task_output', {
            task_id: taskId,
            offset,
            known_verification_fingerprint: knownFingerprint
          })
        }
        assert.equal(received, report)
        phase = 'reread'
      } else {
        rereadIndex++
      }
      if (rereadIndex < rereads.length) {
        const read = rereads[rereadIndex]
        if (read.change) {
          currentVerification = { ...verification, modelVerdict: 'fail' }
        }
        return tool('task_output', {
          task_id: taskId,
          offset: read.offset,
          ...(read.known
            ? { known_verification_fingerprint: read.latest ? latestFingerprint : knownFingerprint }
            : {})
        })
      }
      return answer('ALL_SAVED_BYTES_AND_VERIFICATION_READ')
    })
    const settings = sdk.SettingsManager.inMemory(
      { compaction: { enabled: false }, retry: { enabled: false } },
      { projectTrusted: false }
    )
    const manager = sdk.SessionManager.create(f.cwd, join(f.root, 'verification-parent'))
    const loader = new sdk.DefaultResourceLoader({
      cwd: f.cwd,
      agentDir: f.agentDir,
      settingsManager: settings,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      systemPromptOverride: () => 'Offline verification paging fixture.',
      extensionFactories: [
        (pi) => {
          controller = registerTaskAgents(pi, {
            agentDir: f.agentDir,
            Engine: ChangingReportEngine,
            childFactory:
              () =>
              async ({ sessionPath }) => ({
                sessionPath,
                prompt: async () => ({ text: report, verification }),
                steer: async () => {},
                abort: async () => {},
                dispose: async () => {}
              }),
            configLoader: async () => ({
              maxConcurrency: 1,
              roles: { worker: profile },
              diagnostics: []
            })
          })
        }
      ]
    })
    try {
      await loader.reload()
      assert.deepEqual(loader.getExtensions().errors, [])
      parent = (
        await sdk.createAgentSession({
          cwd: f.cwd,
          agentDir: f.agentDir,
          resourceLoader: loader,
          sessionManager: manager,
          settingsManager: settings,
          model: { ...f.model, contextWindow: 1000000 } as sdk.CreateAgentSessionOptions['model'],
          modelRuntime: f.runtime as unknown as sdk.ModelRuntime,
          tools: ['task', 'task_output']
        })
      ).session
      await parent.bindExtensions({
        mode: 'json',
        onError: (error) => {
          throw new Error(error.error)
        },
        abortHandler() {},
        shutdownHandler() {}
      })
      await parent.prompt(
        'Read the complete saved output, then retry and reread verification explicitly.'
      )
      assert.equal(received, report)
      assert.equal(rereadIndex, rereads.length)
      assert.ok(compactFirstPage.length < firstPage.length)
      t.diagnostic(
        `Same first-page provider text: default=${firstPage.length} characters, matching fingerprint=${compactFirstPage.length} characters, saved=${firstPage.length - compactFirstPage.length} characters (JS string length; not tokens).`
      )
      await controller.shutdown()
      const restored = await new TaskEngine({
        rootDir: join(f.agentDir, 'task-agents', 'sessions'),
        cwd: f.cwd,
        parentId: manager.getSessionId(),
        createChild: async () => {
          throw new Error('Recovery must not rerun the child')
        }
      }).init()
      try {
        const read = await restored.output(taskId, { offset: 1 })
        assert.deepEqual(read.verification, verification)
        assert.ok(
          new OutputProjector()
            .result(read, outputWait(), manager.getSessionId())
            .text.includes(fullVerification)
        )
      } finally {
        await restored.close()
      }
    } finally {
      await controller?.shutdown()
      if (parent) {
        await parent.extensionRunner?.emit({ type: 'session_shutdown' })
        parent.dispose()
      }
    }
  }
)
