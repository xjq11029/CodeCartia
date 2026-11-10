import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { cases } from './cases.mjs';

const source = await readFile(new URL('./model.mjs', import.meta.url), 'utf8');
const mutants = [
  ['忽略 revision', 'ref.kind, ref.id, ref.revisionId, ref.snapshotId', 'ref.kind, ref.id, ref.snapshotId'],
  ['忽略 scope', 'ref.sourceViewId, ref.layer, scope]', 'ref.sourceViewId, ref.layer]'],
  ['忽略来源视图', 'ref.snapshotId, ref.sourceViewId, ref.layer, scope]', 'ref.snapshotId, ref.layer, scope]'],
  ['允许自支持', 'if (reaches(input, output))', 'if (false)'],
  ['允许辅助来源洗入自动', "if (derivation.ref.sourceViewId === 'static')", 'if (false)'],
  ['完成者无条件覆盖', 'if (request.requestGeneration !== slot.latestRequestedGeneration)', 'if (false)'],
  ['最新取消恢复旧请求资格', "request.state = 'cancelled';", "request.state = 'cancelled'; this.#state.slots[request.slotKey].latestRequestedGeneration--;"],
  ['最新失败恢复旧请求资格', "request.state = 'failed';", "request.state = 'failed'; this.#state.slots[request.slotKey].latestRequestedGeneration--;"],
  ['重启丢失最新请求世代', 'this.#state = clone(saved);', 'this.#state = clone(saved); for (const slot of Object.values(this.#state.slots)) slot.latestRequestedGeneration = 1;'],
  ['已完成请求可创建新 attempt', "this.#attempt(request.activeAttemptId).decision !== 'sealed_failed'", "this.#attempt(request.activeAttemptId).decision === 'open'"],
  ['失败回调改写已完成结果', "if (request.state !== 'open' || attempts.some((item) => item.decision === 'sealed_completed')) return 'already_terminal';", 'if (false) return \'already_terminal\';'],
  ['跳过损坏恢复校验', 'validateSavedState(this.#state);', '// skipped recovery validation'],
];
const results = [];
for (const [name, before, after] of mutants) {
  assert.equal(source.split(before).length, 2, `mutation anchor not unique: ${name}`);
  const mutated = source.replace(before, after);
  const implementation = await import(`data:text/javascript;base64,${Buffer.from(mutated).toString('base64')}`);
  const killedBy = [];
  for (const [caseName, verify] of cases) {
    try { verify(implementation); } catch { killedBy.push(caseName); }
  }
  assert.ok(killedBy.length, `SURVIVED: ${name}`);
  results.push({ mutation: name, detectedBy: killedBy.length, firstCase: killedBy[0] });
}
console.log(JSON.stringify({ mutationCount: results.length, killed: results.length, results }, null, 2));
