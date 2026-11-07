import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import * as sdk from '@earendil-works/pi-coding-agent';
import { answer, fixture, tool } from './pi-backend-test-helpers.ts';

for (const scenario of ['disabled', 'runtime', 'later-handler-removes'] as const) {
  test(`official before_agent_start provides parent Skill options: ${scenario}`, async t => {
    const f = await fixture(t);
    const globalSkill = join(f.agentDir, 'skills', 'owned-disk');
    const runtimeSkill = join(f.root, 'owned-runtime');
    await Promise.all([mkdir(globalSkill, { recursive: true }), mkdir(runtimeSkill)]);
    await writeFile(join(globalSkill, 'SKILL.md'), '---\nname: owned-disk\ndescription: Owned disk fixture\n---\nFixture.\n');
    await writeFile(join(runtimeSkill, 'SKILL.md'), '---\nname: owned-runtime\ndescription: Owned runtime fixture\n---\nFixture.\n');
    const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } },
      { projectTrusted: false });
    let initial: string[] = [], atAgentStart: string[] = [], final: string[] = [];
    let options: sdk.NormalizedBuildSystemPromptOptions | undefined;
    const loader = new sdk.DefaultResourceLoader({ cwd: f.cwd, agentDir: f.agentDir, settingsManager: settings,
      noExtensions: true, noSkills: scenario === 'disabled', noPromptTemplates: true, noThemes: true,
      extensionFactories: [
        ...(scenario === 'disabled' ? [] : [{ name: 'owned-runtime-skill', factory: (pi: sdk.ExtensionAPI) => {
          pi.on('resources_discover', () => ({ skillPaths: [runtimeSkill] }));
        } }]),
        { name: 'owned-skill-capture', factory: (pi: sdk.ExtensionAPI) => {
          pi.on('before_agent_start', event => {
            options = event.systemPromptOptions;
            initial = options.skills.map(skill => skill.name);
          });
          pi.on('agent_start', () => {
            assert.ok(options);
            atAgentStart = options.skills.map(skill => skill.name);
            options = undefined;
          });
          pi.registerTool({ name: 'owned_skill_probe', label: 'Owned Skill probe', description: 'Inspect the owned prompt options',
            parameters: { type: 'object', properties: {} }, async execute() {
              assert.equal(options, undefined, 'Do not retain prompt options or context file contents');
              final = atAgentStart;
              return { content: [{ type: 'text', text: 'done' }], details: {} };
            } });
        } },
        ...(scenario === 'later-handler-removes' ? [{ name: 'owned-later-filter', factory: (pi: sdk.ExtensionAPI) => {
          pi.on('before_agent_start', event => { event.systemPromptOptions.skills = event.systemPromptOptions.skills.filter(skill => skill.name !== 'owned-runtime'); });
        } }] : []),
      ] });
    await loader.reload();
    f.script(step => step === 1 ? tool('owned_skill_probe', {}) : answer('PARENT_FINISHED'));
    const { session } = await sdk.createAgentSession({ cwd: f.cwd, agentDir: f.agentDir, resourceLoader: loader,
      settingsManager: settings, model: f.model as any, modelRuntime: f.runtime as any,
      sessionManager: sdk.SessionManager.create(f.cwd, join(f.root, 'parent')), tools: ['owned_skill_probe'] });
    try {
      await session.bindExtensions({ mode: 'json', onError: error => { throw new Error(error.error); }, abortHandler() {}, shutdownHandler() {} });
      const accepted = loader.getSkills().skills.map(skill => skill.name);
      await session.prompt('Run the in-memory Skill fixture.');
      if (scenario === 'disabled') {
        assert.deepEqual(accepted, []);
        assert.deepEqual(initial, []);
        assert.deepEqual(atAgentStart, []);
        assert.deepEqual(final, []);
      } else {
        assert.ok(accepted.includes('owned-runtime'), 'Runtime-discovered Skill must be accepted by the parent loader');
        assert.ok(initial.includes('owned-runtime'));
        assert.equal(atAgentStart.includes('owned-runtime'), scenario === 'runtime');
        assert.equal(final.includes('owned-runtime'), scenario === 'runtime');
      }
    } finally {
      await session.dispose();
    }
  });
}
