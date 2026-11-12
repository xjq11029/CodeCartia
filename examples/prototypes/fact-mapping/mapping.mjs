import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { base, normalize, hash, inside, noLinks, readBytes } from "./io.mjs";

export const profileId = "project-loading-reference-mapping-v0.1";
const namespace = "codecartia.project-loading";
const sourceViewId = "automatic-static-project-loading";
const repositoryRoot = path.resolve(base, "../../..");
const rawReportsRoot = path.resolve(base, "../project-loading/reports/raw");
const schemaPath = path.resolve(repositoryRoot, "docs/contracts/M1-统一图与证据契约.md");

function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])]));
  if (value === undefined || typeof value === "number" && !Number.isFinite(value)) throw new Error("NON_JSON_VALUE");
  return value;
}
export const canonicalJSON = value => JSON.stringify(ordered(value));
const identifier = (kind, value) => `${kind}:${hash(canonicalJSON(value)).slice(7)}`;
const ensure = (condition, code) => { if (!condition) throw new Error(code); };
const nonempty = value => typeof value === "string" && value.length > 0;
const same = (left, right) => canonicalJSON(left) === canonicalJSON(right);
const normalizedHash = value => typeof value === "string" && /^(?:sha256:)?[0-9a-f]{64}$/i.test(value) ? `sha256:${value.replace(/^sha256:/i, "").toLowerCase()}` : null;

function endpoint(bytes, offset) {
  ensure(Number.isSafeInteger(offset) && offset >= 0 && offset <= bytes.length, "INVALID_SOURCE_OFFSET");
  if (offset > 0 && offset < bytes.length && bytes[offset - 1] === 13 && bytes[offset] === 10) throw new Error("SOURCE_OFFSET_INSIDE_CRLF");
  const bom = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? 3 : 0;
  ensure(offset === 0 || offset >= bom, "SOURCE_OFFSET_INSIDE_BOM");
  const prefix = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(bom, offset));
  const lines = prefix.replace(/\r\n?/g, "\n").split("\n");
  return { line: lines.length, column: [...lines.at(-1)].length + 1 };
}

function checkedSpan(span, capture) {
  ensure(span && typeof span === "object", "SOURCE_SPAN_REQUIRED");
  const keys = ["startByte", "endByte", "startLine", "startColumn", "endLine", "endColumn"];
  for (const key of keys) ensure(Number.isSafeInteger(span[key]), "INVALID_SOURCE_SPAN");
  ensure(span.endByte > span.startByte, "EMPTY_SOURCE_ANCHOR");
  const a = endpoint(capture.bytes, span.startByte), b = endpoint(capture.bytes, span.endByte);
  ensure(a.line === span.startLine && a.column === span.startColumn && b.line === span.endLine && b.column === span.endColumn, "SOURCE_COORDINATE_MISMATCH");
  return Object.fromEntries(keys.map(key => [key, span[key]]));
}

function projectFile(root, value) {
  ensure(nonempty(value) && !path.isAbsolute(value) && !value.split(/[\\/]/).some(part => part === ".." || part.includes(":")), "INPUT_PATH_OUTSIDE_PROJECT");
  const absolute = path.resolve(root, value);
  ensure(inside(absolute, root) && absolute !== root, "INPUT_PATH_OUTSIDE_PROJECT");
  noLinks(absolute);
  return absolute;
}

function capture(spec) {
  ensure(spec && nonempty(spec.report) && nonempty(spec.projectRoot) && nonempty(spec.projectId), "INPUT_REGISTRATION_REQUIRED");
  const reportPath = path.resolve(base, spec.report);
  ensure(inside(reportPath, rawReportsRoot) && path.extname(reportPath) === ".json", "ONLY_PURE_PROJECT_REPORTS_ALLOWED");
  const reportBytes = readBytes(reportPath);
  const report = JSON.parse(reportBytes.toString("utf8"));
  ensure(report.reportVersion === "project-loading-v0.1", "REPORT_VERSION_MISMATCH");
  ensure(report.projectId === spec.projectId && ["js-ts", "python"].includes(report.language), "REPORT_SCOPE_MISMATCH");
  const requestedRoot = path.resolve(base, spec.projectRoot);
  noLinks(requestedRoot);
  const root = fs.realpathSync(requestedRoot);
  const reportedRoot = report.language === "js-ts" ? report.rootIdentity?.canonicalRoot : report.projectRoot;
  ensure(nonempty(reportedRoot) && fs.realpathSync(reportedRoot) === root, "REPORT_ROOT_MISMATCH");
  const producerPath = path.resolve(base, report.language === "js-ts" ? "../js-ts/project-extract.mjs" : "../python/project_extract.py");
  const producerHash = report.language === "js-ts" ? report.extractorSha256 : report.toolchain?.extractorSha256;
  ensure(normalizedHash(producerHash) === hash(readBytes(producerPath)), "PRODUCER_CHANGED_REPORT_STALE");
  let libraryRoot = null;
  if (report.language === "js-ts") {
    const registrationBytes = readBytes(path.resolve(base, "../js-ts/toolchain.windows-observed.json"));
    const registration = JSON.parse(registrationBytes.toString("utf8"));
    const modulePath = fs.realpathSync(registration.typescriptModule);
    ensure(report.toolchain?.modulePath && fs.realpathSync(report.toolchain.modulePath) === modulePath && report.toolchain.version === registration.observedVersion, "UNREGISTERED_COMPILER");
    ensure(normalizedHash(report.toolchain.moduleSha256) === hash(readBytes(modulePath)) && normalizedHash(report.toolchain.registrationSha256) === hash(registrationBytes), "COMPILER_CHANGED_REPORT_STALE");
    ensure(normalizedHash(report.outputPolicySha256) === hash(readBytes(path.resolve(base, "../js-ts/io-policy.mjs"))), "OUTPUT_POLICY_CHANGED_REPORT_STALE");
    libraryRoot = path.dirname(modulePath);
  }
  ensure(Array.isArray(report.inputManifest) && Array.isArray(report.declarations) && Array.isArray(report.calls) && report.completeness, "MISSING_PROJECT_REPORT_FIELDS");
  const captures = new Map(), registrations = [], realPaths = new Set();
  const rootId = identifier("root", { projectId: spec.projectId, canonicalPath: normalize(root) });
  for (const input of report.inputManifest) {
    ensure(nonempty(input.path) && !captures.has(input.path), "DUPLICATE_OR_INVALID_INPUT");
    let absolute;
    if (input.kind === "toolchain") {
      ensure(libraryRoot && path.isAbsolute(input.path), "UNREGISTERED_SEMANTIC_INPUT");
      absolute = path.resolve(input.path);
      ensure(path.dirname(absolute) === libraryRoot && /^lib(?:\..+)?\.d\.ts$/i.test(path.basename(absolute)), "UNREGISTERED_SEMANTIC_INPUT");
    } else {
      ensure(["source", "config", "metadata"].includes(input.kind), "UNSUPPORTED_INPUT_KIND");
      absolute = projectFile(root, input.path);
    }
    const bytes = readBytes(absolute), real = fs.realpathSync(absolute);
    ensure(!realPaths.has(real), "DUPLICATE_PHYSICAL_INPUT");
    realPaths.add(real);
    ensure(input.sizeBytes === bytes.length && normalizedHash(input.sha256) === hash(bytes), "SOURCE_CHANGED_REPORT_STALE");
    const id = identifier("input", { rootId, path: input.path });
    const registration = { id, accessRegistrationId: identifier("access", { id, sha256: hash(bytes) }), projectId: spec.projectId, path: input.path, absolutePath: normalize(real),
      kind: input.kind, sha256: hash(bytes), sizeBytes: bytes.length, readOnly: true, trustLabel: "untrusted-content" };
    registrations.push(registration);
    captures.set(input.path, { bytes, registration });
  }
  const reportInput = { id: identifier("input-report", { projectId: spec.projectId, reportPath: normalize(reportPath) }), path: normalize(reportPath), sha256: hash(reportBytes),
    sizeBytes: reportBytes.length, kind: "metadata", readOnly: true, trustLabel: "untrusted-content" };
  reportInput.accessRegistrationId = identifier("access", { id: reportInput.id, sha256: reportInput.sha256 });
  return { report, reportBytes, reportInput, root, rootId, captures, registrations, producerHash: normalizedHash(producerHash), spec };
}

export function mapReport(spec) {
  const context = capture(spec);
  const { report, reportInput, rootId, captures, registrations } = context;
  const mappingFingerprint = hash(readBytes(fileURLToPath(import.meta.url)));
  const schemaFingerprint = hash(readBytes(schemaPath));
  const snapshotId = identifier("snapshot", { profileId, projectId: report.projectId, rootId, reportFingerprint: reportInput.sha256, mappingFingerprint, schemaFingerprint,
    producerHash: context.producerHash, inputs: registrations.map(input => [input.id, input.sha256]) });
  const records = [], entities = [], envelopes = [], profiles = [];
  const facts = new Map(), closures = new Map(), support = new Map();
  const scopes = new Map();
  const factKey = ref => canonicalJSON(ref);
  const makeFact = (kind, id, scope, layer, payload) => {
    ensure(!Object.hasOwn(payload, "ref") && !Object.hasOwn(payload, "derivationRefs"), "FACT_BACKLINK_OR_REF_IN_PAYLOAD");
    const body = { ...payload, scope: structuredClone(scope) };
    const ref = { kind, id, revisionId: identifier("revision", body), snapshotId, sourceViewId, scope: structuredClone(scope), layer };
    const record = { ref, ...body };
    const key = factKey(ref);
    if (facts.has(key)) { ensure(same(facts.get(key), record), "SAME_VERSION_DIFFERENT_CONTENT"); return facts.get(key); }
    facts.set(key, record); records.push(record);
    if (kind === "Evidence") closures.set(key, [ref]);
    return record;
  };
  const uniqueRefs = refs => [...new Map(refs.map(ref => [factKey(ref), ref])).values()];
  const reportEvidence = (scope, pointer, value) => {
    const id = identifier("evidence", { scope, reportId: reportInput.id, pointer });
    return makeFact("Evidence", id, scope, "base", { id, inputId: reportInput.id, inputFingerprint: reportInput.sha256,
      locator: { kind: "json-pointer", pointer, valueFingerprint: hash(canonicalJSON(value)) }, carrier: "metadata", production: "automatic", semanticKind: "implementation-fact",
      conditionRefs: [], capturedVersion: snapshotId, accessRegistrationId: reportInput.accessRegistrationId, trustLabel: "untrusted-content",
      extensions: { [namespace]: { version: "0.1", evidenceRole: "actual-producer-record", reportVersion: report.reportVersion } } });
  };
  const sourceEvidence = (scope, file, rawSpan) => {
    const captured = captures.get(file);
    ensure(captured, "SOURCE_NOT_IN_INPUT_MANIFEST");
    const span = checkedSpan(rawSpan, captured);
    const id = identifier("evidence", { scope, inputId: captured.registration.id, span });
    return makeFact("Evidence", id, scope, "base", { id, inputId: captured.registration.id, inputFingerprint: captured.registration.sha256,
      locator: { inputId: captured.registration.id, inputFingerprint: captured.registration.sha256, coordinatePolicyId: "raw-bytes-codepoints-v0.1", normalized: span,
        nativePositions: { tool: "CodeCartia project-loading normalized-byte report", version: report.reportVersion, input: file, unit: "UTF-8-byte-offset", base: 0, endConvention: "exclusive", start: span.startByte, end: span.endByte },
        mappingRefs: [], mappingStatus: "exact" },
      carrier: captured.registration.kind === "config" ? "config" : captured.registration.kind === "metadata" ? "metadata" : "source", production: "automatic", semanticKind: "implementation-fact",
      conditionRefs: [], capturedVersion: snapshotId, accessRegistrationId: captured.registration.accessRegistrationId, trustLabel: "untrusted-content",
      extensions: { [namespace]: { version: "0.1", evidenceRole: "original-source-span", sourcePath: file,
        coordinateBoundary: "Native positions here are the producer report's raw-byte coordinate system. Original compiler/AST-native coordinates were not preserved by this report format; none are invented." } } });
  };
  const getScope = configFile => {
    ensure(nonempty(configFile), "CONFIGURATION_SCOPE_REQUIRED");
    if (scopes.has(configFile)) return scopes.get(configFile);
    const config = report.language === "js-ts" ? report.configurations?.find(item => item.configFile === configFile) : { configFile, discovery: report.discovery };
    ensure(config, "UNREGISTERED_CONFIGURATION_SCOPE");
    const configId = identifier("config", { rootId, configFile, configuration: config });
    const scope = { projectId: report.projectId, environmentId: "unbound:runtime-environment", configId, entryContextId: "unbound:entry-context" };
    const analysisProfileId = identifier("analysis-profile", { profileId, scope, reportVersion: report.reportVersion, producerHash: context.producerHash, mappingFingerprint });
    const fullReportEvidence = reportEvidence(scope, "", report);
    const diagnosticId = identifier("diagnostic", { scope, profileId });
    const diagnostic = makeFact("Diagnostic", diagnosticId, scope, "base", { id: diagnosticId, code: "MAPPING_SCOPE_AND_SCHEMA_SUBSET",
      message: "Runtime environment and entry remain unbound. This mapping checks static reference fields only, without full schema conformance, runtime reachability, conditions or cross-snapshot identity continuity. Directory-set and negative-query freshness are not verified.",
      dependencyRefs: [fullReportEvidence.ref], evidenceRefs: [fullReportEvidence.ref], affectedRefs: [] });
    const completeness = { complete: false, missingInputs: structuredClone(report.completeness.missingInputs || []),
      unsupportedModes: [...new Set([...(report.completeness.unsupportedModes || []), "full-public-schema", "runtime-environment-and-entry-unbound", "runtime-call-targets", "path-conditions", "cross-snapshot-identity-continuity", "directory-set-and-negative-query-freshness"])],
      truncations: structuredClone(report.completeness.truncations || []), freshness: "current", affectedScope: { scope, profileId, fieldScope: "registered input bytes and mapped fields only; not complete project-report freshness" }, diagnosticRefs: [diagnostic.ref] };
    const state = { scope, configFile, analysisProfileId, completeness };
    scopes.set(configFile, state);
    profiles.push({ id: analysisProfileId, profileId, configFile, configuration: config, sourceViewId, allowedInputLayers: ["base", "rule-output"],
      producerFingerprint: context.producerHash, mappingFingerprint, inputCompleteness: structuredClone(report.completeness), effectiveBudgets: report.budgetObservation?.limits || report.effectiveLimits,
      scopeInterpretation: { environment: "not provided by static project report", entry: "not bound by this slice", config: "captured exploration configuration; not a frozen product profile" } });
    envelopes.push({ schemaVersion: "0.2-draft", snapshotId, scope, analysisProfileId, completeness: structuredClone(completeness) });
    return state;
  };
  const derive = (output, inputs, evidenceRefs, state, method) => {
    const inputFactRefs = uniqueRefs(inputs);
    ensure(inputFactRefs.length && inputFactRefs.every(ref => facts.has(factKey(ref))), "DERIVATION_INPUT_REQUIRED");
    const sourceClosure = uniqueRefs(inputFactRefs.flatMap(ref => closures.get(factKey(ref)) || []));
    const id = identifier("derivation", { outputId: output.ref.id, method, scope: state.scope });
    const derivation = makeFact("Derivation", id, state.scope, "rule-output", { outputFactRefs: [output.ref], inputFactRefs, evidenceRefs: uniqueRefs(evidenceRefs),
      analyzerId: "codecartia-project-loading-fact-mapper", version: profileId, ruleIds: ["static-report-field-normalization"], effectiveRuleSetId: state.analysisProfileId,
      contextId: output.extensions?.[namespace]?.contextId || "unbound:execution-context", conditionRefs: [], bindingSummaryRefs: [], method, analysisMode: "static", sourceClosure,
      supportingEvidenceRefs: uniqueRefs(evidenceRefs), opposingEvidenceRefs: [] });
    closures.set(factKey(output.ref), sourceClosure);
    support.set(factKey(output.ref), { outputFactRef: output.ref, derivationRefs: [...(support.get(factKey(output.ref))?.derivationRefs || []), derivation.ref] });
  };
  const declarationIndex = new Map();
  const scopeForRecord = item => getScope(report.language === "js-ts" ? item.configFile : report.configFile);
  const declarationKey = (item, state) => canonicalJSON([state.scope.configId, item.file, item.qualifiedName, item.span]);
  const makeEntityVersion = (item, state, section, index, entityKind) => {
    ensure(nonempty(item.file), "SOURCE_FILE_REQUIRED");
    const rawEvidence = sourceEvidence(state.scope, item.file, item.span);
    const metadataEvidence = reportEvidence(state.scope, `/${section}/${index}`, item);
    const name = entityKind === "symbol" ? item.name : item.callee;
    ensure(nonempty(name) && (entityKind !== "symbol" || nonempty(item.qualifiedName)), "DECLARATION_OR_CALLEE_REQUIRED");
    const identityKey = { namespace: "snapshot-local-project-loading-anchor-v0.1", snapshotId, rootId, configId: state.scope.configId, entityKind, file: item.file,
      name, ...(entityKind === "symbol" ? { qualifiedName: item.qualifiedName } : {}), span: rawEvidence.locator.normalized };
    const id = identifier("entity", identityKey);
    const entityRef = { kind: "EntityRef", entityKind, id, projectId: report.projectId };
    ensure(!entities.some(entity => entity.id === id), "DUPLICATE_LOGICAL_ANCHOR");
    entities.push({ id, kind: entityKind, projectId: report.projectId, identityKey, displayName: name, identityLifetime: "this captured snapshot only" });
    const versionId = identifier("entity-version", { entityId: id });
    const contextId = entityKind === "call-site" ? identifier("syntax-call-context", { entityId: id }) : "unbound:execution-context";
    const evidenceRefs = [rawEvidence.ref, metadataEvidence.ref];
    const version = makeFact("EntityVersion", versionId, state.scope, "base", { entityRef, conditionRefs: [], evidenceRefs, resolution: "confirmed", completeness: structuredClone(state.completeness),
      extensions: { [namespace]: { version: "0.1", section, index, sourcePath: item.file, configFile: state.configFile, language: report.language, contextId,
        assertion: entityKind === "symbol" ? "syntactic declaration exists at this captured anchor" : "syntactic call expression exists at this captured anchor",
        ...(entityKind === "symbol" ? { qualifiedName: item.qualifiedName, declarationKind: item.kind } : { callee: item.callee, bindingKind: item.bindingKind, runtimeTargetMode: "unknown" }) } } });
    derive(version, evidenceRefs, evidenceRefs, state, "Normalize a producer source anchor after independently checking original bytes and coordinates.");
    return { entityRef, version, rawEvidence, metadataEvidence, contextId };
  };

  for (let index = 0; index < report.declarations.length; index++) {
    const item = report.declarations[index], state = scopeForRecord(item);
    const key = declarationKey(item, state);
    ensure(!declarationIndex.has(key), "DUPLICATE_DECLARATION_ANCHOR");
    declarationIndex.set(key, makeEntityVersion(item, state, "declarations", index, "symbol"));
  }
  for (let index = 0; index < report.calls.length; index++) {
    const call = report.calls[index], state = scopeForRecord(call);
    const expectedBinding = report.language === "js-ts" ? "static-signature-reference" : "lexical-declaration-reference";
    ensure(call.bindingKind === expectedBinding && call.runtimeTargetMode === "unknown", "CALL_SEMANTIC_UPGRADE_REFUSED");
    ensure(["confirmed", "unresolved"].includes(call.resolution) && (call.resolution === "confirmed" ? call.target && typeof call.target === "object" : call.target === null), "INVALID_CALL_TARGET_STATE");
    const source = makeEntityVersion(call, state, "calls", index, "call-site");
    let target = null;
    if (call.target) {
      target = declarationIndex.get(declarationKey(call.target, state));
      ensure(target, "TARGET_NOT_AN_EXACT_DECLARED_ANCHOR");
    }
    const evidenceRefs = [source.rawEvidence.ref, source.metadataEvidence.ref, ...(target ? [target.rawEvidence.ref, target.metadataEvidence.ref] : [])];
    const relationId = identifier("relation", { type: "reference", source: source.entityRef, scope: state.scope, contextId: source.contextId });
    const relation = makeFact("Relation", relationId, state.scope, "rule-output", { type: "reference", sourceRef: source.entityRef,
      targetMode: target ? "exact" : "unknown", targetRefs: target ? [target.entityRef] : [], excludedTargets: [], targetSetCompleteness: target ? "complete" : "unknown",
      contextId: source.contextId, conditionRefs: [], evidenceRefs, resolution: call.resolution, completeness: structuredClone(state.completeness),
      extensions: { [namespace]: { version: "0.1", section: "calls", index, sourcePath: call.file, configFile: state.configFile, language: report.language,
        bindingKind: expectedBinding, runtimeTargetMode: "unknown", executionReachability: "not-evaluated", contextId: source.contextId,
        targetSetScope: "the reported static declaration/signature reference only; not the set of runtime callees" } } });
    derive(relation, [source.version.ref, ...(target ? [target.version.ref] : []), ...evidenceRefs], evidenceRefs, state,
      "Preserve the producer's static reference and unknown state; do not infer execution, business actions or authorization.");
  }
  const supportEntries = [...support.values()];
  return {
    schemaVersion: "0.2-draft", subsetProfileId: profileId, fullSchemaConformance: false, projectId: report.projectId, language: report.language,
    sourceReport: { ...reportInput, producerFingerprint: context.producerHash, projectRoot: normalize(context.root) }, inputRegistrations: registrations,
    snapshotDescriptor: { id: snapshotId, kind: "experiment-frozen-input-set", rootId, inputIds: registrations.map(input => input.id), reportInputId: reportInput.id,
      mappingFingerprint, schemaFingerprint, identityPolicy: "snapshot-local anchors; no cross-snapshot identity registry or migration is implemented",
      freshnessVerification: { registeredInputVersions: "matched-current-bytes", producerVersion: "matched-current-producer", completeProjectReport: "not-verified", directorySets: "not-verified", negativeQueries: "not-verified" } },
    envelopes, profiles, entities, records,
    supportIndex: { kind: "host-query-projection", fingerprint: hash(canonicalJSON(supportEntries)), entries: supportEntries },
    fieldMapping: [
      { source: "declarations/file+qualifiedName+span+configFile", target: "snapshot-local EntityRef and EntityVersion", boundary: "No move/rename, identity continuity or full symbol model." },
      { source: "calls/file+span+configFile", target: "call-site EntityRef and EntityVersion", boundary: "Syntactic anchor only; no inferred execution context or argument flow." },
      { source: "original inputManifest and raw-byte spans", target: "Evidence/SourceSpan with exact FactRef", boundary: "Original bytes and code-point coordinates rechecked; original compiler-native offsets absent from producer report are not invented." },
      { source: "calls/resolution+bindingKind+target", target: "reference Relation plus independent Derivation", boundary: "Static reference semantics only; every runtime target stays unknown." },
      { source: "input/producer versions and captured project configuration", target: "snapshot, complete FactRef scope and source closure", boundary: "Environment and entry unbound; no full Snapshot/worker/storage conformance." },
    ],
    unmappedCapabilities: ["imports as public relations", "public Conditions and invocation/value bindings", "HTTP/framework/business/authorization semantics", "cross-snapshot identity", "full Snapshot/schema conformance",
      "rule composition/merged layers", "query/negative-dependency granularity", "virtual/generated source mappings", "worker transport and storage recovery", "runtime calls and observations"],
    evaluationBoundary: "This is a mapping of actual producer records, not an independent semantic truth set or product acceptance result. expected and evaluator verdicts are never read.",
  };
}
