// 将人工编排的演示结果与真实示例源码位置合并为可离线阅读的单文件 HTML。
// 这里不执行代码分析、业务服务、用户工程或外部请求。
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strict as assert } from 'node:assert';
import template from './reader.template.mjs';

const directory = fileURLToPath(new URL('.', import.meta.url));
const repository = resolve(directory, '../..');
const fixture = resolve(repository, 'examples/purchase-demo');
const hash = value => createHash('sha256').update(value).digest('hex');
const slash = path => path.replaceAll('\\', '/');
const modelText = readFileSync(resolve(directory, 'demo-model.json'), 'utf8');
const model = JSON.parse(modelText);
const evidenceIndex = JSON.parse(readFileSync(resolve(fixture, 'evidence-map.json'), 'utf8'));
const allowed = new Set(['.js', '.mjs', '.json', '.html', '.css', '.md']);

function collect(folder) {
  const result = [];
  for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = resolve(folder, entry.name);
    if (entry.isDirectory() && !['node_modules', '.git', 'scripts', 'test'].includes(entry.name)) result.push(...collect(path));
    else if (entry.isFile() && allowed.has(extname(path)) && entry.name !== 'evidence-map.json') {
      const raw = readFileSync(path);
      const content = raw.toString('utf8').replaceAll('\r\n', '\n');
      const localPath = slash(relative(fixture, path));
      const repoPath = slash(relative(repository, path));
      result.push({
        id: repoPath, path: repoPath, relativePath: localPath,
        project: localPath.startsWith('web/') ? 'purchase-web' : 'purchase-service',
        language: extname(path).slice(1), content,
        lineCount: content.split('\n').length, sha256: hash(raw), origin: 'example-source',
      });
    }
  }
  return result;
}

const files = collect(fixture);
const fileMap = new Map(files.map(file => [file.relativePath, file]));
const evidence = Object.entries(evidenceIndex.evidence).map(([id, entry]) => {
  const file = fileMap.get(slash(entry.file));
  assert(file, `证据文件未收录：${id} -> ${entry.file}`);
  assert.equal(entry.sha256, file.sha256, `${id} 的源码指纹已变化，请先运行 pnpm evidence`);
  assert(Number.isInteger(entry.startLine) && Number.isInteger(entry.endLine), `${id} 的行范围不是整数`);
  assert(entry.startLine >= 1 && entry.endLine >= entry.startLine && entry.endLine <= file.lineCount, `${id} 的行范围无效`);
  const excerpt = file.content.split('\n').slice(entry.startLine - 1, entry.endLine).join('\n');
  assert(excerpt.trim(), `${id} 不能映射空片段`);
  return {
    id, fileId: file.id, startLine: entry.startLine, endLine: entry.endLine,
    label: id, kind: file.language === 'md' ? 'example-document' : 'example-code',
    sourceType: file.language === 'md' ? '文档解释' : '示例源码',
    sha256: entry.sha256, excerpt, resultOrigin: 'mock',
  };
});
const declaredEvidenceIds = new Set(evidence.map(item => item.id));
for (const slice of model.evidenceSlices || []) {
  assert(slice.origin === 'mock' && slice.locationOrigin === 'manual-range', `${slice.id} 必须标记人工片段定位与模拟来源`);
  assert(!evidence.some(item => item.id === slice.id), `片段证据 ID 重复：${slice.id}`);
  const parent = slice.parentId ? evidence.find(item => item.id === slice.parentId) : null;
  if (slice.parentId) assert(parent && declaredEvidenceIds.has(parent.id), `${slice.id} 的父证据必须来自原始位置索引`);
  const file = parent ? files.find(item => item.id === parent.fileId) : files.find(item => item.path === slash(slice.file || ''));
  assert(file, `${slice.id} 的源码文件没有内嵌`);
  assert.equal(file.sha256, parent ? parent.sha256 : slice.sha256, `${slice.id} 的源码指纹变化，人工片段定位须重新核对`);
  assert(Number.isInteger(slice.startLine) && Number.isInteger(slice.endLine), `${slice.id} 的行范围不是整数`);
  assert(slice.startLine >= 1 && slice.endLine >= slice.startLine && slice.endLine <= file.lineCount, `${slice.id} 的片段范围无效`);
  if (parent) assert(slice.startLine >= parent.startLine && slice.endLine <= parent.endLine, `${slice.id} 超出原始父证据范围`);
  const excerpt = file.content.split('\n').slice(slice.startLine - 1, slice.endLine).join('\n');
  assert(typeof slice.expectedExcerpt === 'string' && slice.expectedExcerpt.trim(), `${slice.id} 缺少明确源码文本锚点`);
  assert.equal(excerpt, slice.expectedExcerpt, `${slice.id} 的源码文本锚点变化，不能沿用旧片段定位`);
  evidence.push({
    id: slice.id, parentId: parent?.id || null, fileId: file.id, startLine: slice.startLine, endLine: slice.endLine,
    label: slice.label, kind: 'example-code', sourceType: '示例源码 · 人工片段定位',
    sha256: file.sha256, excerpt, resultOrigin: 'mock', locationOrigin: 'manual-range',
    locationBasis: parent ? 'declared-evidence-slice' : 'verified-example-source-range',
  });
}
const evidenceMap = new Map(evidence.map(item => [item.id, item]));
const unique = values => [...new Set(values || [])];
function verifyEvidence(ids, owner) {
  for (const id of ids || []) assert(evidenceMap.has(id), `${owner} 引用了不存在的证据 ${id}`);
}

const roles = model.roles.map(role => ({ ...role, name: role.label || role.id,
  actors: role.actors || [role.actor].filter(Boolean), realm: role.realm || 'realm-purchase' }));
const roleIds = new Set(roles.map(role => role.id));
const nodeIds = new Set(model.nodes.map(node => node.id));
assert.equal(nodeIds.size, model.nodes.length, '图节点 ID 重复');
const nodes = model.nodes.map(node => {
  assert(node.origin === 'mock', `节点 ${node.id} 必须标记为模拟结果`);
  const file = files.find(item => item.path === slash(node.file));
  assert(file, `节点 ${node.id} 的文件不存在：${node.file}`);
  verifyEvidence(node.evidence, node.id);
  const primary = node.evidence.map(id => evidenceMap.get(id)).find(item => item.fileId === file.id);
  assert(primary, `节点 ${node.id} 缺少其自身文件中的证据`);
  assert(node.x >= 0 && node.y >= 0 && node.x + node.w <= 1400 && node.y + node.h <= 880, `节点 ${node.id} 超出画布`);
  return { ...node, fileId: file.id, line: primary.startLine, description: node.detail, status: '模拟关系' };
});
for (let index = 0; index < nodes.length; index += 1) {
  const first = nodes[index];
  for (const second of nodes.slice(index + 1)) {
    const xOverlap = Math.min(first.x + first.w, second.x + second.w) - Math.max(first.x, second.x);
    const yOverlap = Math.min(first.y + first.h, second.y + second.h) - Math.max(first.y, second.y);
    assert(!(xOverlap > 0 && yOverlap > 0), `节点重叠：${first.id}/${second.id}`);
  }
}
const edges = model.edges.map(edge => {
  assert(nodeIds.has(edge.from) && nodeIds.has(edge.to), `关系 ${edge.id} 的端点不存在`);
  assert(edge.origin === 'mock', `关系 ${edge.id} 必须标记为模拟结果`);
  verifyEvidence(edge.evidence, edge.id);
  return { ...edge, source: edge.from, target: edge.to, type: edge.kind, description: edge.detail, status: '模拟关系' };
});
const edgeIds = new Set(edges.map(edge => edge.id));
assert.equal(edgeIds.size, edges.length, '代码关系 ID 重复');
const implementation = { byCodeNode: {}, byCodeEdge: {}, byEvidence: {} };
function addImplementation(index, id, binding) {
  (index[id] ||= []).push(binding);
}
function verifyFlow(scenario, steps) {
  const flow = scenario.flow;
  assert(flow && flow.origin === 'mock', `${scenario.id} 缺少模拟业务流程`);
  assert(Array.isArray(flow.nodes) && Array.isArray(flow.edges) && Array.isArray(flow.paths), `${scenario.id} 的业务流程结构无效`);
  const flowNodes = new Map(flow.nodes.map(node => [node.id, node]));
  const flowEdges = new Map(flow.edges.map(edge => [edge.id, edge]));
  const stepIds = new Set(steps.map(step => step.id));
  assert.equal(flowNodes.size, flow.nodes.length, `${scenario.id} 业务节点 ID 重复`);
  assert.equal(flowEdges.size, flow.edges.length, `${scenario.id} 业务关系 ID 重复`);
  assert(flowNodes.get(flow.startId)?.kind === 'entry', `${scenario.id} 的流程起点不是入口`);
  for (const node of flow.nodes) {
    assert(node.id.startsWith(`${scenario.id}.flow.`), `${node.id} 不属于当前场景`);
    assert(node.origin === 'mock' && stepIds.has(node.stepId), `${node.id} 的步骤绑定或模拟来源无效`);
    assert(['entry', 'check', 'action', 'outcome'].includes(node.kind), `${node.id} 的业务节点类型无效`);
    assert(node.title && node.description, `${node.id} 缺少业务含义`);
    assert(node.codeNodeIds.length && node.evidence.length, `${node.id} 缺少直接实现映射或证据`);
    verifyEvidence(node.evidence, node.id);
    const sourceFiles = new Set(node.codeNodeIds.map(id => {
      const codeNode = nodes.find(item => item.id === id);
      assert(codeNode && codeNode.scenarios.includes(scenario.id), `${node.id} 的代码节点 ${id} 不属于本场景`);
      return codeNode.fileId;
    }));
    for (const id of node.codeEdgeIds) {
      const codeEdge = edges.find(item => item.id === id);
      assert(codeEdge && codeEdge.scenarios.includes(scenario.id), `${node.id} 的调用或数据关系 ${id} 不属于本场景`);
      sourceFiles.add(nodes.find(item => item.id === codeEdge.source).fileId);
      sourceFiles.add(nodes.find(item => item.id === codeEdge.target).fileId);
    }
    for (const id of node.evidence) assert(sourceFiles.has(evidenceMap.get(id).fileId), `${node.id} 的证据 ${id} 未映射到对应代码文件`);
    if (node.kind === 'outcome') {
      assert(node.result && Number.isInteger(node.result.status) && node.result.state && node.result.output, `${node.id} 缺少具体返回结果`);
      if (node.result.status >= 400) assert(node.result.code, `${node.id} 缺少实际错误响应代码`);
      else assert(node.result.code === null && node.result.businessStatus, `${node.id} 不应伪造成功响应中的错误代码`);
      assert(Array.isArray(node.result.fields) && node.result.fields.length, `${node.id} 缺少返回字段`);
    } else assert(!node.result, `${node.id} 不是结果节点，不应报告完成结果`);
    const binding = { scenarioId: scenario.id, stepId: node.stepId, flowNodeId: node.id, title: node.title, kind: node.kind };
    for (const id of node.codeNodeIds) addImplementation(implementation.byCodeNode, id, binding);
    for (const id of node.codeEdgeIds) addImplementation(implementation.byCodeEdge, id, binding);
    for (const id of node.evidence) addImplementation(implementation.byEvidence, id, binding);
  }
  for (const edge of flow.edges) {
    assert(flowNodes.has(edge.from) && flowNodes.has(edge.to), `${edge.id} 引用了不存在的业务节点`);
    assert(edge.origin === 'mock' && edge.label, `${edge.id} 缺少模拟来源或业务条件`);
    assert(flowNodes.get(edge.from).kind !== 'outcome', `${edge.id} 从终点继续执行业务`);
    verifyEvidence(edge.evidence, edge.id);
  }
  const expectedPaths = ['unauthenticated', 'not-found', 'authorization-denied'];
  if (scenario.id !== 'read') expectedPaths.push('invalid-state', scenario.id === 'submit' ? 'invalid-amount' : 'amount-limit', 'audit-failed', 'transaction-failed');
  if (scenario.id === 'approve') expectedPaths.push('receipt-failed');
  expectedPaths.push('success');
  assert.deepEqual(flow.paths.map(path => path.id).sort(), expectedPaths.sort(), `${scenario.id} 的关键成功或失败路径缺失`);
  const visitedNodes = new Set(), visitedEdges = new Set();
  const paths = flow.paths.map(path => {
    assert(path.origin === 'mock' && path.label, `${scenario.id}/${path.id} 缺少模拟来源或说明`);
    assert.equal(path.nodeIds[0], flow.startId, `${path.id} 未从当前入口开始`);
    assert.equal(new Set(path.nodeIds).size, path.nodeIds.length, `${path.id} 存在重复节点或循环`);
    assert.equal(path.edgeIds.length, path.nodeIds.length - 1, `${path.id} 的节点与连线数量不符`);
    assert.equal(path.nodeIds.at(-1), path.outcomeId, `${path.id} 的结果不是路径终点`);
    assert(flowNodes.get(path.outcomeId)?.kind === 'outcome', `${path.id} 没有明确结果终点`);
    path.nodeIds.forEach((id, index) => {
      assert(flowNodes.has(id), `${path.id} 的节点 ${id} 不存在`);
      assert(index === path.nodeIds.length - 1 || flowNodes.get(id).kind !== 'outcome', `${path.id} 从结果节点继续执行`);
      visitedNodes.add(id);
      if (index) {
        const edge = flowEdges.get(path.edgeIds[index - 1]);
        assert(edge && edge.from === path.nodeIds[index - 1] && edge.to === id, `${path.id} 的路径在 ${id} 前断开`);
        visitedEdges.add(edge.id);
      }
    });
    return { ...path, codeNodeIds: unique(path.nodeIds.flatMap(id => flowNodes.get(id).codeNodeIds)),
      codeEdgeIds: unique(path.nodeIds.flatMap(id => flowNodes.get(id).codeEdgeIds)),
      evidence: unique(path.nodeIds.flatMap(id => flowNodes.get(id).evidence)) };
  });
  assert.equal(visitedNodes.size, flow.nodes.length, `${scenario.id} 有业务节点未进入任何完整路径`);
  assert.equal(visitedEdges.size, flow.edges.length, `${scenario.id} 有业务关系未进入任何完整路径`);
  for (const step of steps) {
    const bound = flow.nodes.filter(node => node.stepId === step.id);
    assert.deepEqual(step.flowNodeIds, bound.map(node => node.id), `${step.id} 的步骤与流程绑定不一致`);
    for (const id of step.codeEdgeIds) assert(edgeIds.has(id), `${step.id} 的代码关系 ${id} 不存在`);
  }
  return { ...flow, paths };
}
const scenarios = model.scenarios.map(scenario => {
  assert(scenario.origin === 'mock', `场景 ${scenario.id} 必须标记为模拟结果`);
  for (const role of scenario.roles) assert(roleIds.has(role), `场景 ${scenario.id} 的角色 ${role} 不存在`);
  const steps = scenario.steps.map(step => {
    assert(step.origin === 'mock', `步骤 ${step.id} 必须标记为模拟结果`);
    verifyEvidence(step.evidence, step.id);
    for (const node of step.nodeIds) assert(nodeIds.has(node), `步骤 ${step.id} 的节点 ${node} 不存在`);
    return { ...step, name: step.title, rule: step.business, state: step.stateEffect, exception: step.exceptions,
      authentication: step.auth, ui: step.visibility, entry: step.entry || scenario.entry };
  });
  const flow = verifyFlow(scenario, steps);
  const scenarioEvidence = unique([...(scenario.evidence || []), ...steps.flatMap(step => step.evidence)]);
  verifyEvidence(scenarioEvidence, scenario.id);
  return { ...scenario, name: scenario.title, goal: scenario.summary, trigger: scenario.entry,
    input: scenario.input, output: scenario.output,
    steps, flow, evidence: scenarioEvidence, nodeIds: unique(steps.flatMap(step => step.nodeIds)) };
});
assert.deepEqual(scenarios.map(scenario => scenario.id), ['submit', 'approve', 'read']);
for (const node of nodes) node.businessBindings = implementation.byCodeNode[node.id] || [];
for (const edge of edges) edge.businessBindings = implementation.byCodeEdge[edge.id] || [];
const lifecycle = model.lifecycle;
assert(lifecycle && lifecycle.origin === 'mock', '缺少同一申请的条件状态生命周期');
const stateIds = new Set(lifecycle.states.map(state => state.id));
assert.equal(stateIds.size, lifecycle.states.length, '生命周期状态 ID 重复');
for (const transition of lifecycle.transitions) {
  const scenario = scenarios.find(item => item.id === transition.scenarioId);
  assert(stateIds.has(transition.from) && stateIds.has(transition.to), '生命周期转换引用了不存在的状态');
  assert(transition.origin === 'mock' && transition.condition, '生命周期转换缺少来源或条件');
  assert(scenario?.steps.some(step => step.id === transition.stepId), '生命周期转换未绑定实际业务步骤');
  assert(scenario.flow.nodes.some(node => node.id === transition.flowNodeId && node.stepId === transition.stepId), '生命周期转换未绑定实际业务流程节点');
  verifyEvidence(transition.evidence, `生命周期 ${transition.from}/${transition.to}`);
}
for (const observation of lifecycle.observations) {
  assert(observation.origin === 'mock' && observation.states.every(id => stateIds.has(id)), '读取状态观察范围无效');
  assert(scenarios.find(item => item.id === observation.scenarioId)?.steps.some(step => step.id === observation.stepId), '状态观察未绑定实际业务步骤');
  verifyEvidence(observation.evidence, '生命周期读取观察');
}
for (const dependency of lifecycle.dependencies) {
  assert(dependency.origin === 'mock' && dependency.relation === 'state-precondition' && dependency.automaticCall === false, '状态依赖不能表达为自动业务调用');
  assert(scenarios.some(item => item.id === dependency.fromScenarioId) && scenarios.some(item => item.id === dependency.toScenarioId), '生命周期场景依赖无效');
  verifyEvidence(dependency.evidence, '生命周期场景依赖');
}
const diagnostics = model.diagnostics.map(item => {
  verifyEvidence(item.evidence, item.id);
  assert(item.origin === 'mock', `诊断 ${item.id} 必须标记为模拟结果`);
  return { ...item, status: item.kind };
});
const business = {
  submit: 'DRAFT 且金额大于 0；内存事务成功后转为 SUBMITTED。',
  approve: 'SUBMITTED 且金额不超过 5000；内存事务成功后转为 APPROVED，回执失败不回滚审批。',
  read: 'B0 未指定额外读取状态门槛；读取不自动触发审批。',
};
const matrix = model.matrix.map(row => {
  verifyEvidence(row.evidence, `矩阵 ${row.action}/${row.role}`);
  assert(roleIds.has(row.role), '矩阵角色不存在');
  const scenario = scenarios.find(item => item.id === row.action);
  assert(scenario, '矩阵动作不存在');
  const step = scenario.steps.find(item => item.id === row.stepId) || scenario.steps[0];
  return { ...row, scenarioId: row.action, ui: step.visibility, authentication: '入口要求已认证',
    business: business[row.action], dataScope: step.dataScope };
});
const fingerprint = hash(modelText + files.map(file => `${file.path}:${file.sha256}`).join('\n')).slice(0, 12);
const data = {
  meta: { ...model.meta, origin: 'mock', analyzerRun: false, sourceSnapshot: fingerprint,
    notice: '体验原型 · 模拟分析结果 · 未运行分析器' },
  project: {
    name: 'purchase-demo', description: '合成采购前后端工程：从业务步骤追溯授权、调用与源码。',
    snapshot: `mock-${fingerprint}`, environment: 'B0 · realm-purchase · 合成输入',
    projects: [
      { name: 'purchase-web', kind: '前端', language: '原生 JavaScript' },
      { name: 'purchase-service', kind: '后端', language: 'Node.js / 内存数据' },
    ],
  },
  scenarios, roles,
  subjects: model.subjects.map(subject => ({ ...subject, realm: subject.realm || 'realm-purchase' })),
  resources: model.resources, files, evidence, graph: { width: 1400, height: 880, nodes, edges }, diagnostics, matrix,
  lifecycle, implementation,
  provenance: { resultSource: 'manually-authored-demo', sourceLocation: 'declared-evidence-markers-and-manual-slices', analyzerRun: false,
    declaredEvidenceCount: declaredEvidenceIds.size, manualSliceCount: model.evidenceSlices.length },
};
assert.equal(template.split('__PROTOTYPE_DATA__').length - 1, 1, '模板应恰好包含一个数据标记');
const encoded = JSON.stringify(data).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
const page = template.replace('__PROTOTYPE_DATA__', encoded);
assert(!page.includes('__PROTOTYPE_DATA__'), '成品仍含数据标记');
const inlineScripts = [...page.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
  .filter(match => !match[0].slice(0, match[0].indexOf('>')).includes('application/json'));
for (const match of inlineScripts) new Function(match[1]);
if (!process.argv.includes('--check')) {
  writeFileSync(resolve(directory, 'demo-data.json'), JSON.stringify(data, null, 2) + '\n');
  writeFileSync(resolve(directory, 'index.html'), page);
}
console.log(`${process.argv.includes('--check') ? '已校验' : '已生成'}离线体验原型：${scenarios.length} 场景、${scenarios.reduce((total, s) => total + s.steps.length, 0)} 步骤、${scenarios.reduce((total, s) => total + s.flow.paths.length, 0)} 条完整条件路径、${nodes.length} 代码节点、${evidence.length} 条真实位置证据（${declaredEvidenceIds.size} 索引 / ${model.evidenceSlices.length} 人工片段）。`);
