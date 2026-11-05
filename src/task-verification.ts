import type { ModelVerdict, VerificationReport } from './types.ts';
import type { WorkspaceSnapshot } from './workspace-observation.ts';
import { WORKSPACE_OBSERVATION_SCOPE } from './workspace-observation.ts';

export const FILE_CHANGE_OBSERVATION_NOTICE = 'best-effort observation only; not a filesystem sandbox or security boundary; no_observed_change does not prove that no write occurred';

// Adapted from MCode task-verification.ts at the revision recorded in NOTICE.
export function parseModelVerdict(text: string): ModelVerdict | undefined {
  const lines = text.split(/\r?\n/u);
  const candidates: (ModelVerdict | undefined)[] = [];
  lines.forEach((line, index) => {
    const payload = candidatePayload(line);
    if (payload === undefined) return;
    let value: string | undefined = payload ?? undefined;
    if (payload === null) {
      let next = index + 1;
      while (next < lines.length && !lines[next].trim()) next++;
      value = lines[next];
    }
    candidates.push(value === undefined ? undefined : verdictValue(value));
  });
  const first = candidates[0];
  return first && candidates.every(value => value === first) ? first : undefined;
}

function candidatePayload(line: string): string | null | undefined {
  let value = line.trimStart();
  for (;;) {
    const previous = value;
    value = value.replace(/^(?:>\s*)+/u, '').replace(/^(?:[-+*]|\d+[.)])\s+/u, '')
      .replace(/^#{1,6}\s*/u, '').replace(/^(?:\*{1,2}|_{1,2}|`{1,3}|~{2})\s*/u, '');
    if (value === previous) break;
  }
  const inline = /^VERDICT\s*:(.*)$/iu.exec(value);
  if (inline) return inline[1] ?? '';
  return /^VERDICT(?:\s*(?:\*{1,2}|_{1,2}|`{1,3}|~{2}))*\s*$/iu.test(value) ? null : undefined;
}

function verdictValue(value: string): ModelVerdict | undefined {
  const match = /^[\s*_`~([{<]*(PASS|FAIL|PARTIAL)(?![\p{L}\p{N}_])/iu.exec(value);
  const verdict = match?.[1]?.toLowerCase() as ModelVerdict | undefined;
  if (!verdict || !match) return;
  const tail = value.slice(match[0].length).match(/(?<![\p{L}\p{N}_])(?:PASS|FAIL|PARTIAL)(?![\p{L}\p{N}_])/gu);
  return tail?.some(entry => entry.toLowerCase() !== verdict) ? undefined : verdict;
}

export function buildVerification(before: WorkspaceSnapshot, after: WorkspaceSnapshot, text: string, succeeded: boolean): VerificationReport {
  const modelVerdict = succeeded ? parseModelVerdict(text) : undefined;
  const errors = [...new Set([before.error, after.error].filter((value): value is string => !!value))];
  const changed = errors.length ? [] : [...new Set([...before.entries.keys(), ...after.entries.keys()])]
    .filter(path => before.entries.get(path) !== after.entries.get(path)).sort();
  return {
    ...(modelVerdict ? { modelVerdict } : {}),
    fileChange: errors.length ? 'recording_failed' : changed.length ? 'change_observed' : 'no_observed_change',
    ...(!errors.length ? { changedFiles: changed.slice(0, 200) } : {}),
    observationNotes: [FILE_CHANGE_OBSERVATION_NOTICE, WORKSPACE_OBSERVATION_SCOPE, ...errors,
      ...(changed.length > 200 ? ['changed_files_truncated'] : [])],
  };
}

export function isVerificationReport(value: unknown): value is VerificationReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const report = value as Record<string, unknown>;
  return Object.keys(report).every(key => ['modelVerdict', 'fileChange', 'changedFiles', 'observationNotes'].includes(key))
    && (report.modelVerdict === undefined || typeof report.modelVerdict === 'string' && ['pass', 'fail', 'partial'].includes(report.modelVerdict))
    && typeof report.fileChange === 'string' && ['no_observed_change', 'change_observed', 'uncertain', 'recording_failed'].includes(report.fileChange)
    && (report.changedFiles === undefined || Array.isArray(report.changedFiles) && report.changedFiles.every(path => typeof path === 'string'))
    && Array.isArray(report.observationNotes) && report.observationNotes.every(note => typeof note === 'string');
}

export function verificationText(report: VerificationReport): string {
  return [`model_verdict: ${report.modelVerdict ?? 'missing'}`, `file_change: ${report.fileChange}`,
    `changed_files: ${JSON.stringify(report.changedFiles ?? [])}`, `observation_notes: ${JSON.stringify(report.observationNotes)}`].join('\n');
}
