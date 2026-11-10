import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

// 验证器可以读取独立预期；提取器没有这一输入路径。
const base = path.dirname(fileURLToPath(import.meta.url));
const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
const expectedPath = path.join(base, "expected/checks.json");
const expectedBytes = fs.readFileSync(expectedPath);
const expected = JSON.parse(expectedBytes.toString("utf8"));
const readReport = (name) => JSON.parse(fs.readFileSync(path.join(base, `reports/${name}.json`), "utf8"));
const semantic = readReport("semantic"), components = readReport("components"), encoding = readReport("encoding"), truncated = readReport("truncated");
const callAt = (report, selector) => report.facts.find(f => f.kind === "call" && f.evidence.inputId === selector.file && f.evidence.normalized?.startLine === selector.line);
const targetDeclarations = (report, fact) => fact.targetIds.flatMap(id => report.symbols.find(s => s.id === id)?.declarations || []);
const evaluate = (report, componentReport) => {
  const checks = [];
  const check = (name, passed, detail = null) => checks.push({ name, passed: Boolean(passed), detail });
  for (const e of expected.calls) {
    const call = callAt(report, e);
    check(`call:${e.file}:${e.line}:mode`, call?.targetMode === e.mode, call?.targetMode || "missing");
    if (!call) continue;
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
const reports = { semantic, components, encoding, truncated };
for (const [name, report] of Object.entries(reports)) {
  check(`${name}:extractor-current-script`, report.scriptFingerprint === sha256(fs.readFileSync(path.join(base, "extract.mjs"))));
  check(`${name}:no-expected-in-input-manifest`, report.expectedReadByExtractor === false && report.inputManifest.every(input => !input.inputId.includes("expected/")));
  check(`${name}:raw-input-fingerprints`, report.inputManifest.every(input => sha256(fs.readFileSync(path.isAbsolute(input.inputId) ? input.inputId : path.join(base, input.inputId))) === input.fingerprint.replace("sha256:", "")));
  check(`${name}:compiler-version-source`, report.toolchain.version === "6.0.3" && report.toolchain.moduleFingerprint === sha256(fs.readFileSync(report.toolchain.modulePath)));
}
check("invalid-utf8-is-diagnosed", encoding.diagnostics.some(d => d.code === "INVALID_UTF8") && encoding.completeness.complete === false && encoding.facts.length === 0);
check("invalid-utf8-raw-fingerprint-preserved", encoding.inputManifest.some(input => input.inputId === "inputs/encoding/invalid.ts" && input.encoding === "UTF-8-undecodable"));
check("explicit-node-limit-truncation", truncated.budgetObservation.truncated && truncated.budgetObservation.visitedNodes === truncated.budgetObservation.nodeLimit && truncated.completeness.complete === false && truncated.diagnostics.some(d => d.code === "EXPERIMENT_NODE_LIMIT"));

// 同一独立判据必须能发现已知错连：只在内存破坏真实报告，不改写事实文件。
const corruptions = [
  { name: "swapped-entry-argument", mutate: r => { callAt(r, { file: "inputs/semantic/entry.ts", line: 5 }).invocationBinding.argumentParameterPairs[0].argumentText = "\"/beta\""; } },
  { name: "merged-same-name-target", mutate: r => { callAt(r, { file: "inputs/semantic/entry.ts", line: 17 }).targetIds = [...callAt(r, { file: "inputs/semantic/entry.ts", line: 13 }).targetIds]; } },
  { name: "merged-entry-context", mutate: r => { callAt(r, { file: "inputs/semantic/entry.ts", line: 8 }).contextId = callAt(r, { file: "inputs/semantic/entry.ts", line: 5 }).contextId; } },
  { name: "promoted-recovery-signature", mutate: r => { const c = callAt(r, { file: "inputs/semantic/entry.ts", line: 23 }); c.targetMode = "exact"; c.resolution = "confirmed"; } },
  { name: "utf16-used-as-byte", mutate: r => { r.facts.find(f => f.kind === "coordinate-last-codepoint" && f.evidence.inputId.endsWith("coordinates.ts")).evidence.normalized.startByte = 6; } },
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
fs.writeFileSync(path.join(base, "reports/verification.json"), JSON.stringify(verification, null, 2) + "\n");
process.stdout.write(JSON.stringify({ status: verification.status, passed: verification.passed, total: verification.total, failures: checks.filter(c => !c.passed) }) + "\n");
if (verification.status !== "checks-passed") process.exitCode = 1;
