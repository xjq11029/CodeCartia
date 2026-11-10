import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { reportPath, writeReport } from "./io-policy.mjs";

// 可信实验脚本；只加载显式登记的编译器，不执行 inputs 下任何模块。
export function extract(args = process.argv.slice(2)) {
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1];
};
const base = path.dirname(fileURLToPath(import.meta.url));
const experimentCase = option("--case", "semantic");
if (!["semantic", "components", "encoding", "boundary"].includes(experimentCase)) throw new Error("只有登记的 semantic/components/encoding/boundary 可执行；框架输入保持规格状态。");
const toolConfigPath = path.resolve(base, option("--toolchain", "toolchain.windows-observed.json"));
const outputPath = reportPath(option("--output", `reports/${experimentCase}.json`));
const root = fs.realpathSync(path.join(base, "inputs", experimentCase));
const nodeLimitText = option("--node-limit", "100000");
const nodeLimit = Number(nodeLimitText);
if (!Number.isSafeInteger(nodeLimit) || nodeLimit < 1) throw new Error("必须显式提供正整数实验节点上限。");
const started = performance.now();
const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
const toolConfigBytes = fs.readFileSync(toolConfigPath);
const toolConfig = JSON.parse(toolConfigBytes.toString("utf8"));
const modulePath = fs.realpathSync(toolConfig.typescriptModule);
const libRoot = fs.realpathSync(path.dirname(modulePath));
const ts = createRequire(import.meta.url)(modulePath);
if (ts.version !== toolConfig.observedVersion) throw new Error(`工具版本改变：配置 ${toolConfig.observedVersion}，实际 ${ts.version}；须重新登记。`);
const normalize = (p) => p.replaceAll("\\", "/");
const within = (p, r) => p === r || p.startsWith(r + path.sep);
const readFiles = new Map();
const queries = new Map();
const experimentDiagnostics = [];
const inputRelative = (p) => within(p, root) ? normalize(path.relative(base, p)) : normalize(p);
const allowedPath = (file) => {
  const absolute = path.resolve(file);
  if (!within(absolute, root) && !within(absolute, libRoot)) return null;
  if (!fs.existsSync(absolute)) return absolute;
  const real = fs.realpathSync(absolute);
  return within(real, root) || within(real, libRoot) ? real : null;
};
const readText = (file) => {
  const permitted = allowedPath(file);
  if (!permitted || !fs.existsSync(permitted) || !fs.statSync(permitted).isFile()) return undefined;
  const bytes = fs.readFileSync(permitted);
  readFiles.set(permitted, { bytes, text: null });
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error("UTF-8不能无损往返");
  } catch (error) {
    experimentDiagnostics.push({ code: "INVALID_UTF8", file: inputRelative(permitted), message: error.message });
    return undefined;
  }
  readFiles.set(permitted, { bytes, text });
  return text;
};
const fileExists = (file) => {
  const permitted = allowedPath(file);
  const exists = Boolean(permitted && fs.existsSync(permitted) && fs.statSync(permitted).isFile());
  const key = normalize(path.resolve(file));
  queries.set(key, { path: inputRelative(path.resolve(file)), exists, deniedByRegistration: !permitted });
  return exists;
};
const configPath = path.join(root, "tsconfig.json");
const parsedFile = ts.readConfigFile(configPath, readText);
if (parsedFile.error) throw new Error(ts.flattenDiagnosticMessageText(parsedFile.error.messageText, "\n"));
if (!Array.isArray(parsedFile.config.files) || parsedFile.config.extends || parsedFile.config.include || parsedFile.config.references) throw new Error("局部实验仅接受显式 files 的静态 JSON；不展开 include、extends 或项目引用。");
const parsed = ts.parseJsonConfigFileContent(parsedFile.config, {
  useCaseSensitiveFileNames: true,
  readDirectory: () => [],
  fileExists, readFile: readText,
}, root);
if (parsed.errors.length) throw new Error(parsed.errors.map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("\n"));
const host = ts.createCompilerHost(parsed.options, true);
host.readFile = readText;
host.fileExists = fileExists;
host.directoryExists = (dir) => {
  const permitted = allowedPath(dir);
  const exists = Boolean(permitted && fs.existsSync(permitted) && fs.statSync(permitted).isDirectory());
  queries.set(`directory:${normalize(path.resolve(dir))}`, { kind: "directory", path: inputRelative(path.resolve(dir)), exists, deniedByRegistration: !permitted });
  return exists;
};
host.getCurrentDirectory = () => root;
host.getDirectories = (dir) => allowedPath(dir) ? fs.readdirSync(allowedPath(dir), { withFileTypes: true }).filter(d => d.isDirectory() && allowedPath(path.join(dir, d.name))).map(d => d.name) : [];
host.realpath = (p) => allowedPath(p) || path.resolve(p);
host.writeFile = () => { throw new Error("实验禁止 emit"); };
// createCompilerHost默认getSourceFile绑定默认readFile；显式改写保证全部读取走登记边界。
host.getSourceFile = (file, languageVersion, onError) => {
  const text = readText(file);
  if (text === undefined) return undefined;
  return ts.createSourceFile(file, text, languageVersion, true);
};
const program = ts.createProgram(parsed.fileNames, parsed.options, host);
const checker = program.getTypeChecker();
const nativeDiagnostics = ts.getPreEmitDiagnostics(program);
const diagnostics = [];
const coordinateAt = (text, pos) => {
  if (!Number.isInteger(pos) || pos < 0 || pos > text.length) throw new Error("原生范围越界");
  if (pos > 0 && pos < text.length) {
    const prev = text.charCodeAt(pos - 1), next = text.charCodeAt(pos);
    if ((prev >= 0xd800 && prev <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) || (prev === 13 && next === 10)) {
      throw new Error("端点在UTF-16码点或CRLF内部");
    }
  }
  let line = 1, column = 1;
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < pos;) {
    const cp = text.codePointAt(i);
    if (cp === 13) {
      i += text.charCodeAt(i + 1) === 10 ? 2 : 1;
      line++; column = 1;
    } else if (cp === 10) {
      i++; line++; column = 1;
    } else {
      i += cp > 0xffff ? 2 : 1; column++;
    }
  }
  return { byte: Buffer.byteLength(text.slice(0, pos), "utf8"), line, column };
};
const span = (sf, start, end) => {
  const real = allowedPath(sf.fileName);
  const entry = real && readFiles.get(real);
  const locator = {
    inputId: inputRelative(real || path.resolve(sf.fileName)),
    inputFingerprint: entry ? sha256(entry.bytes) : null,
    coordinatePolicyId: "raw-bytes-codepoints-v0.1",
    nativePositions: { tool: "TypeScript Compiler API", version: ts.version, unit: "UTF-16-code-unit", base: 0, endConvention: "exclusive", start, end },
    mappingStatus: "unavailable",
  };
  try {
    if (!entry || entry.text !== sf.text) throw new Error("SourceFile与登记的原始文本不一致");
    const a = coordinateAt(entry.text, start), b = coordinateAt(entry.text, end);
    locator.normalized = { startByte: a.byte, endByte: b.byte, startLine: a.line, startColumn: a.column, endLine: b.line, endColumn: b.column };
    locator.mappingStatus = "exact";
  } catch (error) {
    diagnostics.push({ code: "COORDINATE_MAPPING_UNAVAILABLE", message: error.message, evidence: { ...locator } });
  }
  return locator;
};
const nodeSpan = (node) => span(node.getSourceFile(), node.getStart(), node.getEnd());
for (const d of nativeDiagnostics) diagnostics.push({
  code: `TS${d.code}`, category: ts.DiagnosticCategory[d.category], message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
  evidence: d.file && typeof d.start === "number" ? span(d.file, d.start, d.start + (d.length || 0)) : null,
});
const symbolRecords = new Map();
const declarationKey = (d) => `${inputRelative(path.resolve(d.getSourceFile().fileName))}#${d.getStart()}:${d.getEnd()}:${ts.SyntaxKind[d.kind]}`;
const symbolRecord = (symbol) => {
  if (!symbol || !symbol.declarations?.length) return null;
  const ds = symbol.declarations.map(d => ({ anchor: declarationKey(d), kind: ts.SyntaxKind[d.kind], evidence: nodeSpan(d) }));
  const id = "symbol:" + sha256(Buffer.from(ds.map(d => d.anchor).sort().join("|"))).slice(0, 24);
  if (!symbolRecords.has(id)) symbolRecords.set(id, { id, displayName: checker.symbolToString(symbol), nativeFlags: symbol.flags, declarations: ds, identityScope: "本次输入版本的局部声明身份；未实现跨编辑稳定身份" });
  return id;
};
const dereference = (symbol) => symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
const signatureObservation = (signature) => {
  const declaration = signature?.declaration;
  if (!declaration) return null;
  let target = declaration;
  if (ts.isArrowFunction(target) || ts.isFunctionExpression(target)) {
    if (ts.isVariableDeclaration(target.parent)) target = target.parent;
  }
  const nameNode = target.name;
  const targetSymbol = nameNode ? checker.getSymbolAtLocation(nameNode) : null;
  const actualImplementation = ts.isFunctionDeclaration(target) || (ts.isVariableDeclaration(target) && target.initializer && (ts.isArrowFunction(target.initializer) || ts.isFunctionExpression(target.initializer)));
  return {
    signatureId: "signature:" + sha256(Buffer.from(declarationKey(declaration))).slice(0, 24),
    signatureText: checker.signatureToString(signature),
    declarationKind: ts.SyntaxKind[declaration.kind], evidence: nodeSpan(declaration),
    targetSymbolId: actualImplementation ? symbolRecord(targetSymbol) : null,
    parameters: signature.parameters.map(s => ({ symbolId: symbolRecord(s), displayName: checker.symbolToString(s) })),
  };
};
const facts = [];
let visitedNodes = 0;
let truncatedAt = null;
const localFiles = program.getSourceFiles().filter(sf => within(path.resolve(sf.fileName), root));
for (const sf of localFiles) {
  const visit = (node) => {
    if (visitedNodes >= nodeLimit) { truncatedAt ||= nodeSpan(node); return; }
    visitedNodes++;
    if (ts.isImportSpecifier(node) || ts.isImportClause(node) && node.name) {
      const native = checker.getSymbolAtLocation(node.name);
      facts.push({ kind: "import-alias", sourceSymbolId: symbolRecord(native), targetSymbolId: symbolRecord(dereference(native)), evidence: nodeSpan(node), production: "automatic", semanticKind: "implementation-fact" });
    }
    if (ts.isCallExpression(node)) {
      const expressionType = checker.getTypeAtLocation(node.expression);
      const nativeSymbol = checker.getSymbolAtLocation(node.expression);
      const resolvedSymbol = dereference(nativeSymbol);
      const resolved = checker.getResolvedSignature(node);
      const errorAtCall = nativeDiagnostics.filter(d => d.category === ts.DiagnosticCategory.Error && d.file === sf && typeof d.start === "number" && d.start < node.getEnd() && d.start + (d.length || 0) >= node.getStart());
      const constituents = expressionType.isUnion() ? expressionType.types : [expressionType];
      const observations = constituents.flatMap(type => checker.getSignaturesOfType(type, ts.SignatureKind.Call)).map(signatureObservation).filter(Boolean);
      const candidates = [...new Map(observations.map(s => [s.signatureId, s])).values()];
      const selected = signatureObservation(resolved);
      const opaque = Boolean(expressionType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown));
      const meaningful = candidates.filter(s => s.targetSymbolId);
      const unknown = opaque || errorAtCall.length > 0 || meaningful.length !== candidates.length || meaningful.length === 0 || !selected?.targetSymbolId;
      const union = expressionType.isUnion() && meaningful.length > 1;
      const targetIds = unknown ? [] : [...new Set((union ? meaningful : [selected]).map(s => s.targetSymbolId))];
      const callSiteId = "call:" + sha256(Buffer.from(declarationKey(node))).slice(0, 24);
      let parentFunction = node.parent;
      while (parentFunction && !ts.isFunctionLike(parentFunction)) parentFunction = parentFunction.parent;
      const ownerSymbolId = parentFunction?.name ? symbolRecord(checker.getSymbolAtLocation(parentFunction.name)) : null;
      facts.push({
        kind: "call", callSiteId, ownerSymbolId,
        sourceSymbolId: symbolRecord(nativeSymbol), resolvedSymbolId: symbolRecord(resolvedSymbol),
        expression: node.expression.getText(), expressionType: checker.typeToString(expressionType),
        targetMode: unknown ? "unknown" : union ? "candidateSet" : "exact",
        targetIds, targetSetCompleteness: unknown ? "unknown" : "complete",
        resolution: unknown ? "unresolved" : "confirmed",
        nativeResolvedSignature: selected, nativeCandidateSignatures: candidates,
        contextId: `local:${callSiteId}`,
        invocationBinding: !unknown && !union ? {
          callSiteId, calleeSignatureId: selected.signatureId,
          argumentParameterPairs: node.arguments.map((argument, i) => ({
            argumentIndex: i, argumentText: argument.getText(), argumentKind: ts.SyntaxKind[argument.kind],
            argumentType: checker.typeToString(checker.getTypeAtLocation(argument)),
            argumentSymbolId: symbolRecord(dereference(checker.getSymbolAtLocation(argument))),
            parameterSymbolId: selected.parameters[i]?.symbolId || null, evidence: nodeSpan(argument),
          })),
          returnResultPair: { callSiteId, returnType: checker.typeToString(checker.getReturnTypeOfSignature(resolved)), resultEvidence: nodeSpan(node) },
          scope: "此静态调用点到签名的局部配对；没有跨上游实例展开、值版本或入口传播",
        } : null,
        completeness: { complete: !unknown, missingInputs: [], unsupportedModes: unknown ? [opaque ? "any-or-unknown-target" : errorAtCall.length ? "diagnostic-affects-call" : "no-visible-implementation-declaration"] : [], truncations: [], freshness: "current" },
        diagnosticCodes: errorAtCall.map(d => `TS${d.code}`), evidence: nodeSpan(node), production: "automatic", semanticKind: "implementation-fact",
      });
    }
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && ts.isIdentifier(node.tagName)) {
      const symbol = checker.getSymbolAtLocation(node.tagName);
      facts.push({ kind: "jsx-tag-symbol", tag: node.tagName.getText(), targetSymbolId: symbolRecord(dereference(symbol)), evidence: nodeSpan(node.tagName), interpretation: "原生标签符号引用；未验证React/Vue渲染或框架入口", production: "automatic" });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, sf.languageVariant, sf.text);
  let token;
  while ((token = scanner.scan()) !== ts.SyntaxKind.EndOfFileToken) {
    if (token === ts.SyntaxKind.SingleLineCommentTrivia) {
      const start = scanner.getTokenPos(), end = scanner.getTextPos();
      facts.push({ kind: "coordinate-trivia", nativeToken: ts.SyntaxKind[token], evidence: span(sf, start, end) });
      const text = scanner.getTokenText(), last = [...text].at(-1);
      facts.push({ kind: "coordinate-last-codepoint", value: last, evidence: span(sf, end - last.length, end) });
    }
  }
}
if (truncatedAt) diagnostics.push({ code: "EXPERIMENT_NODE_LIMIT", message: "AST访问达到显式局部实验上限；余下节点未扫描。", evidence: truncatedAt, observed: visitedNodes, limit: nodeLimit });
diagnostics.push(...experimentDiagnostics);
const inputManifest = [...readFiles].map(([file, entry]) => ({
  inputId: inputRelative(file), fingerprint: "sha256:" + sha256(entry.bytes), byteLength: entry.bytes.length, encoding: entry.text === null ? "UTF-8-undecodable" : "UTF-8-lossless", carrier: within(file, root) ? file.endsWith(".json") ? "config" : "source" : "semantic-library",
})).sort((a, b) => a.inputId.localeCompare(b.inputId));
const incomplete = diagnostics.some(d => d.category === "Error" || ["EXPERIMENT_NODE_LIMIT", "INVALID_UTF8", "COORDINATE_MAPPING_UNAVAILABLE"].includes(d.code));
const report = {
  experimentId: `M1-04-JS-TS-${experimentCase}`, status: "semantic-local-executed",
  format: "codecartia-local-experiment-v0.1", contractMapping: "M1-02 0.1-draft 的局部字段核对；非完整schema兼容、非worker实现",
  sourceViewId: "automatic-static-local", capturedAt: new Date().toISOString(),
  toolchain: { name: "TypeScript Compiler API", version: ts.version, source: toolConfig.source, modulePath: normalize(modulePath), moduleFingerprint: sha256(fs.readFileSync(modulePath)), externalRegistrations: [{ root: normalize(libRoot), purpose: "可信候选编译器及只读内置类型定义" }], nodeVersion: process.version, platform: process.platform, architecture: process.arch },
  inputManifest, scriptFingerprint: sha256(fs.readFileSync(new URL(import.meta.url))), outputPolicyFingerprint: sha256(fs.readFileSync(new URL("./io-policy.mjs", import.meta.url))), toolConfigFingerprint: sha256(toolConfigBytes), compilerOptions: parsed.options,
  command: { actual: [process.execPath, fileURLToPath(import.meta.url), ...args], reproduce: `pnpm extract --case ${experimentCase} --toolchain toolchain.windows-observed.json --node-limit ${nodeLimit} --output ${normalize(path.relative(base, outputPath))}` },
  durationMs: performance.now() - started,
  peakMemoryObservation: { maxRSS: process.resourceUsage().maxRSS, maxRSSUnit: "Node process.resourceUsage kilobytes", memoryAtEnd: process.memoryUsage(), limitation: "进程资源观察；非产品负载/性能验收" },
  registeredRoot: normalize(root), expectedReadByExtractor: false,
  resolutionQueries: [...queries.values()], symbols: [...symbolRecords.values()], facts, diagnostics,
  budgetObservation: { profileId: "local-ast-node-limit-observed", nodeLimit, visitedNodes, truncated: Boolean(truncatedAt) },
  completeness: { complete: !incomplete, missingInputs: diagnostics.filter(d => d.code === "TS2307"), unsupportedModes: ["跨入口多层传播", "HTTP分发", "业务/授权", "框架语义", "完整公共schema", "worker协议", "增量恢复"], truncations: truncatedAt ? [{ profileId: "local-ast-node-limit-observed", nodeLimit, visitedNodes, evidence: truncatedAt }] : [], freshness: "current", affectedScope: experimentCase },
  scopeLimitations: ["真实Compiler API局部静态符号/签名与原始坐标；不执行输入。", "所有工具查询仅限登记源码根和TypeScript内置lib根；无下载/构建。", "完整性只针对登记的局部扫描和有据绑定，不能解释为LC/语言/框架/产品深度准入。", "selected签名是静态类型观察，合法候选不证明运行时目标。", "ID在本次不可变输入里可复核，不保证跨编辑稳定。"],
};
writeReport(outputPath, report);
process.stdout.write(JSON.stringify({ output: normalize(outputPath), status: report.status, version: ts.version, facts: facts.length, diagnostics: diagnostics.length, complete: report.completeness.complete, visitedNodes, durationMs: report.durationMs }) + "\n");
return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) extract();
