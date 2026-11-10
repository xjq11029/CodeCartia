import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { writeReport } from "./io-policy.mjs";

// 验证器可以读取独立预期；提取器没有这一输入路径。
const base = path.dirname(fileURLToPath(import.meta.url));
const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
const expectedPath = path.join(base, "expected/checks.json");
const expectedBytes = fs.readFileSync(expectedPath);
const expected = JSON.parse(expectedBytes.toString("utf8"));
const toolConfigBytes = fs.readFileSync(path.join(base, "toolchain.windows-observed.json"));
const toolConfig = JSON.parse(toolConfigBytes);
const allowedEvidenceRoots = [fs.realpathSync(path.join(base, "inputs")), fs.realpathSync(path.dirname(toolConfig.typescriptModule))];
const within = (candidate, root) => candidate === root || candidate.startsWith(root + path.sep);
const sourceCache = new Map();
const readEvidence = (report, evidence) => {
  try {
    if (!evidence || evidence.mappingStatus !== "exact" || evidence.coordinatePolicyId !== "raw-bytes-codepoints-v0.1") throw new Error("非精确原始位置");
    const registered = report.inputManifest.find(item => item.inputId === evidence.inputId);
    if (!registered) throw new Error("证据输入未登记");
    const file = fs.realpathSync(path.resolve(base, evidence.inputId));
    if (!allowedEvidenceRoots.some(root => within(file, root))) throw new Error("证据输入越过固定源码/类型根");
    if (!sourceCache.has(file)) sourceCache.set(file, fs.readFileSync(file));
    const raw = sourceCache.get(file);
    if (evidence.inputFingerprint !== sha256(raw) || registered.fingerprint !== "sha256:" + sha256(raw)) throw new Error("证据与原始输入指纹不一致");
    const n = evidence.normalized, native = evidence.nativePositions;
    if (!n || !Number.isSafeInteger(n.startByte) || !Number.isSafeInteger(n.endByte) || n.startByte < 0 || n.endByte < n.startByte || n.endByte > raw.length) throw new Error("字节范围越界");
    const endpoint = offset => {
      if (offset > 0 && offset < raw.length && raw[offset - 1] === 13 && raw[offset] === 10) throw new Error("端点位于CRLF内部");
      const prefix = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw.subarray(0, offset));
      const lines = prefix.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
      return { nativeOffset: prefix.length, line: lines.length, column: [...lines.at(-1)].length + 1 };
    };
    const start = endpoint(n.startByte), end = endpoint(n.endByte);
    if (!native || native.unit !== "UTF-16-code-unit" || native.base !== 0 || native.endConvention !== "exclusive" || native.start !== start.nativeOffset || native.end !== end.nativeOffset) throw new Error("原生位置与原始字节不对应");
    if (n.startLine !== start.line || n.startColumn !== start.column || n.endLine !== end.line || n.endColumn !== end.column) throw new Error("行列与原始字节不对应");
    return { valid: true, text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw.subarray(n.startByte, n.endByte)) };
  } catch (error) { return { valid: false, reason: error.message }; }
};
const evidenceFailures = report => {
  const failures = [];
  const walk = (value, key) => {
    if (!value || typeof value !== "object") return;
    if ("mappingStatus" in value || "nativePositions" in value) {
      const result = readEvidence(report, value);
      if (!result.valid) failures.push({ path: key, reason: result.reason });
      return;
    }
    for (const [childKey, child] of Object.entries(value)) walk(child, `${key}.${childKey}`);
  };
  walk(report.facts, "facts"); walk(report.symbols, "symbols"); walk(report.diagnostics, "diagnostics");
  return failures;
};
const readReport = (name) => JSON.parse(fs.readFileSync(path.join(base, `reports/${name}.json`), "utf8"));
const semantic = readReport("semantic"), components = readReport("components"), encoding = readReport("encoding"), truncated = readReport("truncated"), boundary = readReport("boundary");
const callAt = (report, selector) => report.facts.find(f => f.kind === "call" && f.evidence.inputId === selector.file && f.evidence.normalized?.startLine === selector.line);
const targetDeclarations = (report, fact) => fact.targetIds.flatMap(id => report.symbols.find(s => s.id === id)?.declarations || []);
const evaluate = (report, componentReport) => {
  const checks = [];
  const check = (name, passed, detail = null) => checks.push({ name, passed: Boolean(passed), detail });
  for (const [name, current] of [["semantic", report], ["components", componentReport]]) {
    const failures = evidenceFailures(current);
    check(`${name}:every-call-declaration-argument-and-diagnostic-evidence`, failures.length === 0, failures);
  }
  check("exact-independent-call-inventory", report.facts.filter(f => f.kind === "call").length === expected.calls.length && expected.calls.every(e => report.facts.filter(f => f.kind === "call" && f.evidence.inputId === e.file && f.evidence.normalized?.startLine === e.line).length === 1));
  for (const e of expected.calls) {
    const call = callAt(report, e);
    check(`call:${e.file}:${e.line}:mode`, call?.targetMode === e.mode, call?.targetMode || "missing");
    if (!call) continue;
    const source = readEvidence(report, call.evidence);
    check(`call:${e.file}:${e.line}:independent-source-expression`, source.valid && source.text === e.callText, source);
    for (const pair of call.invocationBinding?.argumentParameterPairs || []) {
      const argument = readEvidence(report, pair.evidence);
      check(`argument:${e.file}:${e.line}:${pair.argumentIndex}:raw-source`, argument.valid && argument.text === pair.argumentText);
    }
    if (e.mode === "exact") check(`call:${e.line}:exact-single-target`, call.targetIds.length === 1 && call.targetIds[0] === call.nativeResolvedSignature?.targetSymbolId && call.resolution === "confirmed");
    if (e.targetFile) check(`call:${e.line}:actual-declaration`, targetDeclarations(report, call).some(d => d.evidence.inputId === e.targetFile && d.evidence.normalized.startLine === e.targetLine));
    if (e.argument) check(`call:${e.line}:argument-parameter-pair`, call.invocationBinding?.argumentParameterPairs[0]?.argumentText === e.argument && Boolean(call.invocationBinding?.argumentParameterPairs[0]?.parameterSymbolId));
    if (e.signatureFile) check(`call:${e.line}:overload-signature`, call.nativeResolvedSignature?.evidence.inputId === e.signatureFile && call.nativeResolvedSignature?.evidence.normalized.startLine === e.signatureLine);
    if (e.returnType) check(`call:${e.line}:return-type`, call.invocationBinding?.returnResultPair.returnType === e.returnType);
    if (e.candidateDeclarations) {
      const declarations = targetDeclarations(report, call);
      check(`call:${e.line}:candidate-declarations`, call.targetIds.length === e.candidateDeclarations.length && e.candidateDeclarations.every(c => declarations.some(d => d.evidence.inputId === c.file && d.evidence.normalized.startLine === c.line)));
      check(`call:${e.line}:no-selected-runtime-target`, call.invocationBinding === null && call.resolution === "confirmed" && call.targetSetCompleteness === "complete");
    }
    if (e.mode === "unknown") check(`call:${e.line}:no-recovery-confirmation`, call.resolution === "unresolved" && call.targetIds.length === 0 && call.invocationBinding === null && call.completeness.complete === false);
    if (e.diagnostic) check(`call:${e.line}:error-diagnostic`, call.diagnosticCodes.includes(e.diagnostic));
  }
  for (const e of expected.mustDiffer) {
    const a = callAt(report, e.a), b = callAt(report, e.b);
    check(`scope-separation:${e.field}:${e.a.line}:${e.b.line}`, a && b && JSON.stringify(a[e.field]) !== JSON.stringify(b[e.field]));
  }
  for (const e of expected.sameTargetDifferentArguments) {
    const a = callAt(report, e.a), b = callAt(report, e.b);
    check("shared-target-independent-callsite-arguments", a && b && a.targetIds[0] === b.targetIds[0] && a.callSiteId !== b.callSiteId && a.invocationBinding.argumentParameterPairs[0].argumentText !== b.invocationBinding.argumentParameterPairs[0].argumentText);
    check("shared-formal-does-not-create-full-entry-propagation", a && b && a.invocationBinding.argumentParameterPairs[0].parameterSymbolId === b.invocationBinding.argumentParameterPairs[0].parameterSymbolId && report.scopeLimitations.some(text => text.includes("完整性")));
  }
  for (const code of expected.diagnostics) check(`native-diagnostic:${code}`, report.diagnostics.some(d => d.code === code && d.evidence?.mappingStatus === "exact"));
  for (const e of expected.coordinates) {
    const fact = report.facts.find(f => f.kind === "coordinate-last-codepoint" && f.evidence.inputId === e.file);
    check(`coordinate:${e.file}:native-and-normalized`, fact && fact.value === e.value && fact.evidence.nativePositions.start === e.nativeStart && fact.evidence.nativePositions.end === e.nativeEnd && JSON.stringify(fact.evidence.normalized) === JSON.stringify(e.normalized));
    const raw = fs.readFileSync(path.join(base, e.file));
    check(`coordinate:${e.file}:raw-byte-slice`, raw.subarray(e.normalized.startByte, e.normalized.endByte).toString("utf8") === e.value && raw.includes(Buffer.from("\r\n")));
  }
  for (const e of expected.jsx) {
    const fact = componentReport.facts.find(f => f.kind === "jsx-tag-symbol" && f.evidence.inputId === e.file && f.evidence.normalized?.startLine === e.line);
    const declaration = componentReport.symbols.find(s => s.id === fact?.targetSymbolId)?.declarations;
    check(`jsx:${e.file}:native-symbol`, declaration?.some(d => d.evidence.inputId === e.targetFile && d.evidence.normalized.startLine === e.targetLine));
  }
  const imported = report.facts.filter(f => f.kind === "import-alias").filter(f => f.targetSymbolId);
  check("actual-import-alias-dereference", imported.length >= 4 && imported.every(f => f.sourceSymbolId !== f.targetSymbolId));
  check("missing-input-query-recorded", report.resolutionQueries.some(q => q.path.includes("not-provided") && q.exists === false && q.deniedByRegistration === false));
  check("negative-input-makes-report-incomplete", report.completeness.complete === false);
  check("local-jsx-without-framework-claim", componentReport.diagnostics.length === 0 && componentReport.scopeLimitations.some(text => text.includes("深度准入")));
  return checks;
};
const checks = evaluate(semantic, components);
const check = (name, passed, detail = null) => checks.push({ name, passed: Boolean(passed), detail });
const reports = { semantic, components, encoding, truncated, boundary };
for (const [name, report] of Object.entries(reports)) {
  check(`${name}:extractor-current-script`, report.scriptFingerprint === sha256(fs.readFileSync(path.join(base, "extract.mjs"))));
  check(`${name}:output-policy-current`, report.outputPolicyFingerprint === sha256(fs.readFileSync(path.join(base, "io-policy.mjs"))));
  check(`${name}:no-expected-in-input-manifest`, report.expectedReadByExtractor === false && report.inputManifest.every(input => !input.inputId.includes("expected/")));
  check(`${name}:raw-input-fingerprints`, report.inputManifest.every(input => sha256(fs.readFileSync(path.isAbsolute(input.inputId) ? input.inputId : path.join(base, input.inputId))) === input.fingerprint.replace("sha256:", "")));
  check(`${name}:query-observations-current`, report.resolutionQueries.filter(q => !q.deniedByRegistration).every(q => { const p = path.isAbsolute(q.path) ? q.path : path.join(base, q.path); return q.exists === (fs.existsSync(p) && (q.kind === "directory" ? fs.statSync(p).isDirectory() : fs.statSync(p).isFile())); }));
  check(`${name}:compiler-version-source`, report.toolchain.version === toolConfig.observedVersion && report.toolchain.moduleFingerprint === sha256(fs.readFileSync(report.toolchain.modulePath)) && report.toolConfigFingerprint === sha256(toolConfigBytes));
}
check("invalid-utf8-is-diagnosed", encoding.diagnostics.some(d => d.code === "INVALID_UTF8") && encoding.completeness.complete === false && encoding.facts.length === 0);
check("invalid-utf8-raw-fingerprint-preserved", encoding.inputManifest.some(input => input.inputId === "inputs/encoding/invalid.ts" && input.encoding === "UTF-8-undecodable"));
check("explicit-node-limit-truncation", truncated.budgetObservation.truncated && truncated.budgetObservation.visitedNodes === truncated.budgetObservation.nodeLimit && truncated.completeness.complete === false && truncated.diagnostics.some(d => d.code === "EXPERIMENT_NODE_LIMIT"));
check("outside-case-import-denied", boundary.resolutionQueries.some(q => q.path.includes("inputs/semantic") && q.deniedByRegistration) && boundary.inputManifest.every(i => !i.inputId.includes("inputs/semantic/")));
check("source-and-target-plugin-not-executed", ["sentinel", "plugin"].every(name => !fs.existsSync(path.join(base, `inputs/boundary/${name}.executed`))) && boundary.inputManifest.some(i => i.inputId === "inputs/boundary/sentinel.js") && !boundary.inputManifest.some(i => i.inputId.includes("plugin.cjs")));
const boundaryPolicy = JSON.parse(fs.readFileSync(path.join(base, "reports/boundary-policy.json"), "utf8"));
check("current-boundary-run-and-output-refusal", boundaryPolicy.runnerFingerprint === sha256(fs.readFileSync(path.join(base, "run.mjs"))) && boundaryPolicy.outputRefused && boundaryPolicy.sentinelsAbsentBeforeAndAfter);
check("all-report-writers-reject-linked-final-path-and-parent", boundaryPolicy.outputPolicyFingerprint === sha256(fs.readFileSync(path.join(base, "io-policy.mjs"))) && boundaryPolicy.linkChecks?.length === 2 && boundaryPolicy.linkChecks.every(item => item.passed));

// 同一独立判据必须能发现已知错连：只在内存破坏真实报告，不改写事实文件。
const corruptions = [
  { name: "swapped-entry-argument", mutate: r => { callAt(r, { file: "inputs/semantic/entry.ts", line: 5 }).invocationBinding.argumentParameterPairs[0].argumentText = "\"/beta\""; } },
  { name: "merged-same-name-target", mutate: r => { callAt(r, { file: "inputs/semantic/entry.ts", line: 17 }).targetIds = [...callAt(r, { file: "inputs/semantic/entry.ts", line: 13 }).targetIds]; } },
  { name: "merged-entry-context", mutate: r => { callAt(r, { file: "inputs/semantic/entry.ts", line: 8 }).contextId = callAt(r, { file: "inputs/semantic/entry.ts", line: 5 }).contextId; } },
  { name: "promoted-recovery-signature", mutate: r => { const c = callAt(r, { file: "inputs/semantic/entry.ts", line: 23 }); c.targetMode = "exact"; c.resolution = "confirmed"; } },
  { name: "utf16-used-as-byte", mutate: r => { r.facts.find(f => f.kind === "coordinate-last-codepoint" && f.evidence.inputId.endsWith("coordinates.ts")).evidence.normalized.startByte = 6; } },
  { name: "missing-call", mutate: r => { r.facts.splice(r.facts.findIndex(f => f.kind === "call"), 1); } },
  { name: "extra-candidate", mutate: r => { callAt(r, { file: "inputs/semantic/entry.ts", line: 5 }).targetIds.push("wrong-target"); } },
  { name: "missing-union-candidate", mutate: r => { callAt(r, { file: "inputs/semantic/entry.ts", line: 22 }).targetIds.pop(); } },
  { name: "extra-call", mutate: r => { r.facts.push(structuredClone(r.facts.find(f => f.kind === "call"))); } },
  { name: "call-byte-end-outside-source", mutate: r => { callAt(r, { file: "inputs/semantic/entry.ts", line: 5 }).evidence.normalized.endByte += 10000; } },
  { name: "call-evidence-wrong-fingerprint", mutate: r => { callAt(r, { file: "inputs/semantic/entry.ts", line: 5 }).evidence.inputFingerprint = "wrong"; } },
  { name: "call-column-disagrees-with-bytes", mutate: r => { callAt(r, { file: "inputs/semantic/entry.ts", line: 5 }).evidence.normalized.endColumn += 1; } },
  { name: "target-declaration-byte-end-outside-source", mutate: r => { const target = callAt(r, { file: "inputs/semantic/entry.ts", line: 5 }).targetIds[0]; r.symbols.find(s => s.id === target).declarations[0].evidence.normalized.endByte += 10000; } },
  { name: "overload-evidence-wrong-fingerprint", mutate: r => { callAt(r, { file: "inputs/semantic/entry.ts", line: 20 }).nativeResolvedSignature.evidence.inputFingerprint = "wrong"; } },
  { name: "argument-evidence-wrong-source-range", mutate: r => { callAt(r, { file: "inputs/semantic/entry.ts", line: 5 }).invocationBinding.argumentParameterPairs[0].evidence.normalized.startByte += 1; } },
];
for (const corruption of corruptions) {
  const clone = structuredClone(semantic);
  corruption.mutate(clone);
  check(`oracle-rejects:${corruption.name}`, evaluate(clone, components).some(c => !c.passed));
}
const verification = {
  experimentId: "M1-04-JS-TS-local-verification", status: checks.every(c => c.passed) ? "checks-passed" : "checks-failed",
  source: "独立SPEC和expected；局部实验，非产品验收分数", expectedFingerprint: sha256(expectedBytes), verifierFingerprint: sha256(fs.readFileSync(new URL(import.meta.url))),
  reportFingerprints: Object.fromEntries(Object.keys(reports).map(name => [name, sha256(fs.readFileSync(path.join(base, `reports/${name}.json`)))])),
  passed: checks.filter(c => c.passed).length, total: checks.length, checks,
};
writeReport("reports/verification.json", verification);
process.stdout.write(JSON.stringify({ status: verification.status, passed: verification.passed, total: verification.total, failures: checks.filter(c => !c.passed) }) + "\n");
if (verification.status !== "checks-passed") process.exitCode = 1;
