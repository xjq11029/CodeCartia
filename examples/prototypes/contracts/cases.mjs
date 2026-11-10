import assert from 'node:assert/strict';

const ref = (id, revisionId = 'v1', overrides = {}) => ({
  kind: 'Relation', id, revisionId, snapshotId: 'snapshot-input-1', sourceViewId: 'static',
  scope: { projectId: 'p', environmentId: 'e', configId: 'c', entryContextId: 'entry' },
  layer: 'rule-output', ...overrides,
});
const record = (reference, value, production = 'automatic') => ({ ref: reference, value, production });
const derivation = (id, inputs, outputs, overrides = {}) => ({
  ref: ref(id, 'v1', { kind: 'Derivation', ...overrides }), inputFactRefs: inputs, outputFactRefs: outputs,
});
const slot = { workspaceId: 'w', publicationScopeId: 'p:e:c', sourceViewId: 'static' };
const frozen = (rule) => ({ inputManifest: 'same-input', configId: 'c', analysisProfileId: `profile-${rule}`, effectiveRuleSetId: rule });
const launch = (coordinator, id, rule = id, chosenSlot = slot) => {
  const generation = coordinator.register(chosenSlot, id, frozen(rule));
  coordinator.start(id, `${id}-attempt`);
  return generation;
};
const finish = (coordinator, id) => { coordinator.finish(`${id}-attempt`, `snapshot-${id}`, { result: id }); return coordinator.prepare(`${id}-attempt`); };

export const cases = [
  ['R11 两个 revision 按精确引用解析，与到达顺序无关', ({ FactStore }) => {
    for (const reverse of [false, true]) {
      const store = new FactStore();
      const inputs = [record(ref('r'), ['A']), record(ref('r', 'v2'), ['A', 'B'])];
      if (reverse) inputs.reverse();
      inputs.forEach((item) => store.addFact(item));
      assert.deepEqual(store.resolve(ref('r')).value, ['A']);
      assert.deepEqual(store.resolve(ref('r', 'v2')).value, ['A', 'B']);
      assert.throws(() => store.resolve(ref('r', 'v3')), /missing exact/);
    }
  }],
  ['R11 所有引用维度参与解析，不能用同 ID 补错快照或 scope', ({ FactStore }) => {
    const store = new FactStore(); store.addFact(record(ref('r'), 'original'));
    const variants = [ref('r', 'v1', { kind: 'Claim' }), ref('r', 'v1', { snapshotId: 'other' }), ref('r', 'v1', { sourceViewId: 'assisted' }), ref('r', 'v1', { layer: 'merged' })];
    for (const field of ['projectId', 'environmentId', 'configId', 'entryContextId']) variants.push(ref('r', 'v1', { scope: { ...ref('r').scope, [field]: 'other' } }));
    for (const variant of variants) assert.throws(() => store.resolve(variant), /missing exact/);
  }],
  ['R11 ID-only、EntityRef 和缺失精确键字段不能成为事实引用', ({ FactStore }) => {
    const store = new FactStore(); store.addFact(record(ref('r'), 'original'));
    for (const invalid of ['r', { kind: 'EntityRef', entityKind: 'Symbol', id: 'r', projectId: 'p' }]) assert.throws(() => store.resolve(invalid));
    for (const field of ['kind', 'id', 'revisionId', 'snapshotId', 'sourceViewId', 'scope', 'layer']) {
      const incomplete = ref('r'); delete incomplete[field]; assert.throws(() => store.resolve(incomplete));
    }
  }],
  ['R11 同精确版本不能被不同内容原位覆盖', ({ FactStore }) => {
    const store = new FactStore(); store.addFact(record(ref('r'), ['A']));
    store.addFact(record(ref('r'), ['A']));
    assert.throws(() => store.addFact(record(ref('r'), ['B'])), /same version changed/);
    assert.deepEqual(store.resolve(ref('r')).value, ['A']);
  }],
  ['R11 消费者保留输入 revision，不自动跟随另一版本', ({ FactStore }) => {
    const store = new FactStore();
    [record(ref('r'), ['A']), record(ref('r', 'v2'), ['A', 'B']), record(ref('q', 'v1', { layer: 'merged' }), 'claim')].forEach((item) => store.addFact(item));
    store.addDerivation(derivation('d', [ref('r')], [ref('q', 'v1', { layer: 'merged' })]));
    assert.equal(store.supports(ref('q', 'v1', { layer: 'merged' }))[0].inputFactRefs[0].revisionId, 'v1');
  }],
  ['R11 独立支持是两个分支，撤销一个仍保留另一个', ({ FactStore }) => {
    const store = new FactStore(); const a = ref('a'), b = ref('b'), out = ref('out', 'v1', { layer: 'merged' });
    for (const item of [a, b, out]) store.addFact(record(item, item.id));
    const d1 = derivation('d1', [a], [out]), d2 = derivation('d2', [b], [out]);
    store.addDerivation(d1); store.addDerivation(d2);
    assert.deepEqual(store.supports(out).map((item) => item.ref.id).sort(), ['d1', 'd2']);
    store.removeDerivation(d1.ref);
    assert.deepEqual(store.supports(out).map((item) => item.ref.id), ['d2']);
    assert.deepEqual(store.supports(out)[0].inputFactRefs.map((item) => item.id), ['b']);
  }],
  ['R11 支持反向索引不写回不可变事实，不产生内容指纹循环', ({ FactStore }) => {
    const store = new FactStore(); const input = ref('input'), output = ref('out', 'v1', { layer: 'merged' });
    store.addFact(record(input, 'input')); const original = record(output, 'out'); store.addFact(original);
    store.addDerivation(derivation('d', [input], [output]));
    assert.deepEqual(store.resolve(output), original);
    assert.throws(() => store.addFact({ ...original, derivationRefs: [ref('d', 'v1', { kind: 'Derivation' })] }), /query projection/);
  }],
  ['R11 辅助分支不改变自动视图，自动推导拒绝人工依赖', ({ FactStore }) => {
    const store = new FactStore();
    const automatic = ref('a', 'v1', { layer: 'base' });
    const manual = ref('a', 'v1', { sourceViewId: 'assisted', layer: 'overlay' });
    const automaticOut = ref('out', 'v1', { layer: 'merged' });
    const assistedOut = ref('out', 'v1', { layer: 'merged', sourceViewId: 'assisted' });
    [record(automatic, 'a'), record(manual, 'manual', 'manual'), record(automaticOut, 'out'), record(assistedOut, 'out', 'mixed')].forEach((item) => store.addFact(item));
    store.addDerivation(derivation('static-d', [automatic], [automaticOut]));
    store.addDerivation({ ...derivation('manual-d', [manual], [assistedOut], { sourceViewId: 'assisted' }), allowedInputViews: ['assisted'] });
    assert.throws(() => store.addDerivation({ ...derivation('launder', [manual], [automaticOut]), allowedInputViews: ['static', 'assisted'] }), /auxiliary source/);
    assert.deepEqual(store.supports(automaticOut).map((item) => item.ref.id), ['static-d']);
    assert.deepEqual(store.supports(assistedOut).map((item) => item.ref.id), ['manual-d']);
  }],
  ['R11 直接和间接自支持拒绝，但旧版本到新版本的有根推导允许', ({ FactStore }) => {
    const store = new FactStore(); const a = ref('a'), b = ref('b'), newer = ref('a', 'v2');
    for (const item of [a, b, newer]) store.addFact(record(item, item.id));
    assert.throws(() => store.addDerivation(derivation('self', [a], [a])), /self-support/);
    store.addDerivation(derivation('ab', [a], [b]));
    assert.throws(() => store.addDerivation(derivation('ba', [b], [a])), /cyclic/);
    store.addDerivation(derivation('advance', [b], [newer]));
    assert.equal(store.supports(newer)[0].ref.id, 'advance');
  }],
  ['R11 相同快照内跨来源未登记依赖也拒绝', ({ FactStore }) => {
    const store = new FactStore(); const input = ref('i', 'v1', { sourceViewId: 'auxiliary' }), out = ref('o');
    store.addFact(record(input, 'i')); store.addFact(record(out, 'o'));
    assert.throws(() => store.addDerivation(derivation('d', [input], [out])), /undeclared source view/);
  }],
  ['R12 同输入同 scope 不同规则，后发先完成只发布后请求', ({ PublicationCoordinator }) => {
    const host = new PublicationCoordinator(); assert.equal(launch(host, 'A', 'rules-A'), 1); assert.equal(launch(host, 'B', 'rules-B'), 2);
    assert.equal(host.commit(finish(host, 'B')), 'published'); assert.equal(host.commit(finish(host, 'A')), 'superseded');
    assert.equal(host.current(slot).snapshotId, 'snapshot-B');
    assert.equal(host.history('snapshot-A').frozen.effectiveRuleSetId, 'rules-A');
    assert.equal(host.attempt('A-attempt').decision, 'sealed_completed'); assert.equal(host.attempt('A-attempt').publicationState, 'historical');
  }],
  ['R12 早请求先完成也须等待最新请求，完成顺序不能决定资格', ({ PublicationCoordinator }) => {
    const host = new PublicationCoordinator(); launch(host, 'A'); launch(host, 'B');
    assert.equal(host.commit(finish(host, 'A')), 'superseded'); assert.equal(host.current(slot), null);
    assert.equal(host.commit(finish(host, 'B')), 'published'); assert.equal(host.current(slot).snapshotId, 'snapshot-B');
  }],
  ['R12 eligible 预检后出现新请求，最终提交必须重新比较', ({ PublicationCoordinator }) => {
    const host = new PublicationCoordinator(); launch(host, 'A'); const ticket = finish(host, 'A'); launch(host, 'B');
    assert.equal(host.commit(ticket), 'superseded'); assert.equal(host.current(slot), null);
  }],
  ['R12 最新取消后不能让早请求补位，原当前与历史均可查', ({ PublicationCoordinator }) => {
    const host = new PublicationCoordinator(); launch(host, 'original'); host.commit(finish(host, 'original'));
    launch(host, 'A'); launch(host, 'B'); assert.equal(host.cancel('B'), 'accepted');
    assert.equal(host.commit(finish(host, 'A')), 'superseded'); assert.equal(host.current(slot).snapshotId, 'snapshot-original');
    assert.equal(host.history('snapshot-A').payload.result, 'A'); assert.throws(() => finish(host, 'B'), /terminal/);
  }],
  ['R12 最新失败或预先拒绝仍保留世代，不自动恢复旧资格', ({ PublicationCoordinator }) => {
    for (const startWorker of [false, true]) {
      const host = new PublicationCoordinator(); launch(host, 'A'); host.register(slot, 'B', frozen('B'));
      if (startWorker) host.start('B', 'B-attempt'); host.fail('B');
      assert.equal(host.commit(finish(host, 'A')), 'superseded'); assert.equal(host.current(slot), null);
    }
  }],
  ['R12 恢复保留失败/取消请求的最新世代，而非最大成功世代', ({ PublicationCoordinator }) => {
    for (const stop of ['cancel', 'fail']) {
      let host = new PublicationCoordinator(); launch(host, 'original'); host.commit(finish(host, 'original'));
      launch(host, 'A'); launch(host, 'B'); host[stop]('B'); host = new PublicationCoordinator(host.exportState());
      assert.equal(host.commit(finish(host, 'A')), 'superseded'); assert.equal(host.current(slot).snapshotId, 'snapshot-original');
      assert.equal(launch(host, 'C'), 4); assert.equal(host.commit(finish(host, 'C')), 'published');
    }
  }],
  ['R12 独立槽位互不阻塞，来源视图和范围分别保存当前指针', ({ PublicationCoordinator }) => {
    const host = new PublicationCoordinator(); const other = { ...slot, publicationScopeId: 'other' }, auxiliary = { ...slot, sourceViewId: 'assisted' };
    assert.equal(launch(host, 'A'), 1); assert.equal(launch(host, 'B', 'B', other), 1); assert.equal(launch(host, 'C', 'C', auxiliary), 1);
    for (const id of ['B', 'C', 'A']) assert.equal(host.commit(finish(host, id)), 'published');
    assert.equal(host.current(slot).snapshotId, 'snapshot-A'); assert.equal(host.current(other).snapshotId, 'snapshot-B'); assert.equal(host.current(auxiliary).snapshotId, 'snapshot-C');
  }],
  ['R12 同请求重发不增世代，重复发布幂等，变更冻结配置必须新请求', ({ PublicationCoordinator }) => {
    const host = new PublicationCoordinator(); assert.equal(launch(host, 'A'), 1); assert.equal(host.register(slot, 'A', frozen('A')), 1);
    assert.throws(() => host.register(slot, 'A', frozen('different')), /identity reused/);
    const ticket = finish(host, 'A'); assert.equal(host.commit(ticket), 'published'); assert.equal(host.commit(ticket), 'already_published');
    assert.equal(host.cancel('A'), 'already_terminal'); assert.equal(host.current(slot).snapshotId, 'snapshot-A');
  }],
  ['R12 内部重试不越过新用户请求，旧 attempt 不能借同世代复活', ({ PublicationCoordinator }) => {
    const host = new PublicationCoordinator(); launch(host, 'A'); host.failAttempt('A-attempt'); host.start('A', 'A-retry'); launch(host, 'B');
    assert.throws(() => host.finish('A-attempt', 'old', {}), /terminal/);
    host.finish('A-retry', 'retry-result', {}); assert.equal(host.commit(host.prepare('A-retry')), 'superseded');
    assert.equal(host.commit(finish(host, 'B')), 'published'); assert.equal(host.current(slot).snapshotId, 'snapshot-B');
  }],
  ['R12 已完成请求不能通过创建第二 attempt 重获同世代发布资格', ({ PublicationCoordinator }) => {
    for (const publish of [false, true]) {
      const host = new PublicationCoordinator(); launch(host, 'A'); const ticket = finish(host, 'A');
      if (publish) host.commit(ticket);
      assert.throws(() => host.start('A', 'second-attempt'), /only failed attempt/);
      assert.equal(launch(host, 'new-user-request'), 2);
    }
  }],
  ['R12 fail 不能逆转已完成或已发布尝试，也不能改变取消裁决', ({ PublicationCoordinator }) => {
    for (const publish of [false, true]) {
      const host = new PublicationCoordinator(); launch(host, 'A'); const ticket = finish(host, 'A');
      if (publish) host.commit(ticket);
      const before = host.exportState(); assert.equal(host.fail('A'), 'already_terminal'); assert.deepEqual(host.exportState(), before);
      if (!publish) assert.equal(host.commit(ticket), 'published');
      assert.equal(host.current(slot).snapshotId, 'snapshot-A');
    }
    const host = new PublicationCoordinator(); launch(host, 'cancelled'); host.cancel('cancelled');
    const before = host.exportState(); assert.equal(host.fail('cancelled'), 'already_terminal'); assert.deepEqual(host.exportState(), before);
  }],
  ['R12 损坏恢复状态拒绝，不能猜测世代或指向其他槽位的快照', ({ PublicationCoordinator }) => {
    const host = new PublicationCoordinator(); launch(host, 'original'); host.commit(finish(host, 'original')); launch(host, 'latest'); host.cancel('latest');
    const saved = host.exportState(); const key = Object.keys(saved.slots)[0];
    const mutations = [
      (state) => { state.slots[key].latestRequestedGeneration = 1; },
      (state) => { state.slots[key].latestRequestedGeneration = 3; },
      (state) => { state.slots[key].currentSnapshotId = 'missing'; },
      (state) => { state.requests.latest.slotKey = 'missing-slot'; },
      (state) => { state.snapshots['snapshot-original'].requestGeneration = 2; },
      (state) => { state.requests.original.activeAttemptId = 'latest-attempt'; },
      (state) => { state.attempts['original-attempt'].publicationState = 'isolated'; },
    ];
    for (const mutate of mutations) {
      const damaged = structuredClone(saved); mutate(damaged);
      assert.throws(() => new PublicationCoordinator(damaged), /inconsistent saved/);
    }
    assert.equal(new PublicationCoordinator(saved).current(slot).snapshotId, 'snapshot-original');
  }],
];
