import test from 'node:test';
import assert from 'node:assert/strict';
import { toolResult } from '../src/extension.ts';

test('a full output page is preserved when the engine has advanced its byte cursor', () => {
  const output = 'a'.repeat(65536);
  const result = toolResult({ output, offset: 0, next_offset: 65536, has_more: true, final_text: 'b'.repeat(90000) });
  const visible = JSON.parse(result.content[0].text);
  assert.equal(visible.output, output);
  assert.equal(Buffer.byteLength(visible.output), visible.next_offset - visible.offset);
  assert.equal(result.details.output, output);
  assert.ok(visible.final_text.length < 90000);
});
