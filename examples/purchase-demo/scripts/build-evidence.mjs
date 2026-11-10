import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const root = new URL('../', import.meta.url);
const evidence = {};

for (const directory of ['web', 'server', 'data', 'config']) {
  for (const file of (await readdir(new URL(`${directory}/`, root))).sort()) {
    if (!file.endsWith('.js')) continue;
    const path = `${directory}/${file}`;
    const source = await readFile(new URL(path, root), 'utf8');
    const lines = source.split(/\r?\n/);
    const open = new Map();
    const sha256 = createHash('sha256').update(source).digest('hex');
    for (let index = 0; index < lines.length; index++) {
      const match = lines[index].match(/\/\/ @evidence (F\.[\w.-]+):(start|end)/);
      if (!match) continue;
      const [, id, edge] = match;
      if (edge === 'start') {
        if (open.has(id) || evidence[id]) throw new Error(`重复证据标签：${id}`);
        open.set(id, index + 2);
      } else {
        if (!open.has(id)) throw new Error(`缺少证据开始标签：${id}`);
        evidence[id] = { file: path, startLine: open.get(id), endLine: index, sha256 };
        open.delete(id);
      }
    }
    if (open.size) throw new Error(`未闭合证据：${[...open.keys()].join(', ')}`);
  }
}

const workflowPath = 'config/workflow.json';
const workflowSource = await readFile(new URL(workflowPath, root), 'utf8');
const workflowEvidence = {
  file: workflowPath,
  startLine: 1,
  endLine: workflowSource.trimEnd().split(/\r?\n/).length,
  sha256: createHash('sha256').update(workflowSource).digest('hex'),
};
evidence['F.workflow.actor-bindings'] = { ...workflowEvidence };
evidence['F.workflow.config'] = { ...workflowEvidence };

const docSource = await readFile(new URL('README.md', root), 'utf8');
const docLines = docSource.split(/\r?\n/);
evidence['F.doc.flow'] = {
  file: 'README.md',
  startLine: docLines.findIndex(line => line === '<!-- @evidence F.doc.flow:start -->') + 2,
  endLine: docLines.findIndex(line => line === '<!-- @evidence F.doc.flow:end -->'),
  sha256: createHash('sha256').update(docSource).digest('hex'),
};

await writeFile(new URL('evidence-map.json', root), `${JSON.stringify({
  format: 'codecartia-demo-evidence-v1',
  scope: '合成示例逻辑段位置索引，非自动分析结果或独立验收真值',
  evidence,
}, null, 2)}\n`, 'utf8');
console.log(`已生成 ${Object.keys(evidence).length} 个证据标签的源码位置与文件 SHA-256。`);
