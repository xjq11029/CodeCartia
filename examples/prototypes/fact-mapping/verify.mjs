import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { base, readBytes, writeJSON, noLinks } from "./io.mjs";

// Independent checks intentionally do not import the mapper, its ID functions or its data structures.
const sha = bytes => `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}
const eq = (left, right) => stable(left) === stable(right);
const profile = "project-loading-reference-mapping-v0.1";
const ns = "codecartia.project-loading";
const file = path.join(base, "reports/bundles.json");
const originalBytes = readBytes(file);
const original = JSON.parse(originalBytes.toString("utf8"));
const registryBytes = readBytes(path.join(base, "inputs.json"));
const registry = JSON.parse(registryBytes.toString("utf8"));
const rawInputs = new Map(registry.cases.map(entry => [entry.projectId, { entry, raw: JSON.parse(readBytes(path.resolve(base, entry.report)).toString("utf8")) }]));
const cachedBytes = new Map();

function originalCoordinates(bytes, span) {
  const endpoint = offset => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length) throw new Error("offset-range");
    if (offset && offset < bytes.length && bytes[offset - 1] === 13 && bytes[offset] === 10) throw new Error("crlf-interior");
    const prefix = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, offset)).replace(/^\uFEFF/, "");
    const rows = prefix.replace(/\r\n|\r/g, "\n").split("\n");
    return [rows.length, Array.from(rows.at(-1)).length + 1];
  };
  if (!span || !Number.isSafeInteger(span.endByte) || !(span.endByte > span.startByte)) return false;
  try {
    const start = endpoint(span.startByte), end = endpoint(span.endByte);
    return start[0] === span.startLine && start[1] === span.startColumn && end[0] === span.endLine && end[1] === span.endColumn;
  } catch { return false; }
}

function check(document) {
  const issues = [];
  const require = (condition, code, detail = "") => { if (!condition) issues.push({ code, detail }); return Boolean(condition); };
  require(document.schemaVersion === "0.2-draft" && document.subsetProfileId === profile && document.fullSchemaConformance === false, "E_BUNDLE_PROFILE");
  require(document.registryFingerprint === sha(registryBytes), "E_REGISTRY_STALE");
  for (const name of ["build.mjs", "mapping.mjs", "io.mjs"]) require(document.generatorFingerprints?.[name] === sha(readBytes(path.join(base, name))), "E_GENERATOR_STALE", name);
  require(Array.isArray(document.bundles) && document.bundles.length === registry.cases.length, "E_EMPTY_OR_EXTRA_BUNDLES");
  if (!Array.isArray(document.bundles)) return issues;
  require(new Set(document.bundles.map(bundle => bundle.projectId)).size === document.bundles.length, "E_DUPLICATE_PROJECT");
  for (const bundle of document.bundles) {
    const input = rawInputs.get(bundle.projectId);
    if (!require(input, "E_UNREGISTERED_PROJECT", bundle.projectId)) continue;
    const { entry, raw } = input;
    const rawBytes = readBytes(path.resolve(base, entry.report));
    const projectRoot = fs.realpathSync(path.resolve(base, entry.projectRoot));
    require(bundle.schemaVersion === "0.2-draft" && bundle.subsetProfileId === profile && bundle.fullSchemaConformance === false, "E_BUNDLE_PROFILE", bundle.projectId);
    require(bundle.language === raw.language && raw.projectId === bundle.projectId && raw.reportVersion === "project-loading-v0.1", "E_PRODUCER_SCOPE");
    require(bundle.sourceReport?.sha256 === sha(rawBytes) && bundle.sourceReport.sizeBytes === rawBytes.length && fs.realpathSync(bundle.sourceReport.projectRoot) === projectRoot, "E_SOURCE_REPORT_STALE");
    const producerFile = path.resolve(base, raw.language === "js-ts" ? "../js-ts/project-extract.mjs" : "../python/project_extract.py");
    require(bundle.sourceReport.producerFingerprint === sha(readBytes(producerFile)), "E_PRODUCER_STALE");
    require(bundle.snapshotDescriptor.mappingFingerprint === sha(readBytes(path.join(base, "mapping.mjs"))), "E_GENERATOR_STALE", "snapshot mapper");
    require(bundle.snapshotDescriptor.schemaFingerprint === sha(readBytes(path.resolve(base, "../../../docs/contracts/M1-统一图与证据契约.md"))), "E_SCHEMA_STALE");
    const registrations = new Map();
    for (const registered of bundle.inputRegistrations || []) {
      const originalInput = raw.inputManifest.find(item => item.path === registered.path && item.kind === registered.kind);
      if (!require(originalInput && !registrations.has(registered.id), "E_INPUT_REGISTRATION", registered.path)) continue;
      let sourceFile;
      if (registered.kind === "toolchain") {
        const toolConfig = JSON.parse(readBytes(path.resolve(base, "../js-ts/toolchain.windows-observed.json")).toString("utf8"));
        const libraryRoot = path.dirname(fs.realpathSync(toolConfig.typescriptModule));
        sourceFile = path.resolve(registered.path);
        if (!require(path.dirname(sourceFile) === libraryRoot && /^lib(?:\..+)?\.d\.ts$/i.test(path.basename(sourceFile)), "E_INPUT_REGISTRATION", "external input")) continue;
      } else {
        if (!require(typeof registered.path === "string" && !path.isAbsolute(registered.path) && !registered.path.split(/[\\/]/).some(part => part === ".." || part.includes(":")), "E_INPUT_REGISTRATION", "relative input")) continue;
        sourceFile = path.resolve(projectRoot, registered.path);
      }
      noLinks(sourceFile);
      if (!cachedBytes.has(sourceFile)) cachedBytes.set(sourceFile, readBytes(sourceFile));
      const bytes = cachedBytes.get(sourceFile);
      require(registered.sha256 === originalInput.sha256 && registered.sha256 === sha(bytes) && registered.sizeBytes === bytes.length, "E_INPUT_STALE", registered.path);
      require(registered.readOnly === true && registered.trustLabel === "untrusted-content" && fs.realpathSync(registered.absolutePath) === fs.realpathSync(sourceFile), "E_INPUT_REGISTRATION", registered.path);
      registrations.set(registered.id, { ...registered, bytes });
    }
    require(registrations.size === raw.inputManifest.length, "E_INPUT_OMITTED");
    const reportRegistration = { ...bundle.sourceReport, bytes: rawBytes };
    registrations.set(reportRegistration.id, reportRegistration);
    const records = bundle.records || [], byRef = new Map(), entities = new Map((bundle.entities || []).map(entity => [entity.id, entity]));
    const expectedRootId = `root:${sha(stable({ projectId: bundle.projectId, canonicalPath: projectRoot.replaceAll("\\", "/") })).slice(7)}`;
    require(bundle.snapshotDescriptor.rootId === expectedRootId, "E_ROOT_IDENTITY");
    const configurationScopes = new Map();
    for (const configurationProfile of bundle.profiles || []) {
      const expectedConfiguration = raw.language === "js-ts" ? raw.configurations.find(item => item.configFile === configurationProfile.configFile) : { configFile: raw.configFile, discovery: raw.discovery };
      if (!require(expectedConfiguration && eq(expectedConfiguration, configurationProfile.configuration), "E_CONFIGURATION_SCOPE")) continue;
      const expectedConfigId = `config:${sha(stable({ rootId: expectedRootId, configFile: configurationProfile.configFile, configuration: expectedConfiguration })).slice(7)}`;
      const matchingEnvelope = bundle.envelopes.find(envelope => envelope.analysisProfileId === configurationProfile.id);
      require(matchingEnvelope?.scope.configId === expectedConfigId, "E_CONFIGURATION_SCOPE");
      configurationScopes.set(expectedConfigId, configurationProfile.configFile);
    }
    const allowedKinds = new Set(["EntityVersion", "Evidence", "Relation", "Diagnostic", "Derivation"]);
    const allowedLayers = new Set(["base", "rule-output"]);
    const declaredScopes = new Set((bundle.envelopes || []).map(envelope => stable(envelope.scope)));
    const validRef = ref => {
      if (!ref || typeof ref !== "object" || !allowedKinds.has(ref.kind) || !allowedLayers.has(ref.layer)) return false;
      if (!["id", "revisionId", "snapshotId", "sourceViewId"].every(key => typeof ref[key] === "string" && ref[key].length > 0)) return false;
      return ref.scope && ["projectId", "environmentId", "configId", "entryContextId"].every(key => typeof ref.scope[key] === "string" && ref.scope[key].length > 0);
    };
    for (const record of records) {
      if (!require(validRef(record.ref), "E_REF_SCHEMA")) continue;
      const key = stable(record.ref);
      require(!byRef.has(key), "E_DUPLICATE_EXACT_VERSION"); byRef.set(key, record);
      require(!Object.hasOwn(record, "derivationRefs"), "E_BACKLINK_PAYLOAD");
      require(eq(record.scope, record.ref.scope) && record.scope.projectId === bundle.projectId && declaredScopes.has(stable(record.scope)), "E_SCOPE");
      require(record.ref.snapshotId === bundle.snapshotDescriptor.id && record.ref.sourceViewId === "automatic-static-project-loading", "E_SNAPSHOT_VIEW");
      require(record.scope.environmentId === "unbound:runtime-environment" && record.scope.entryContextId === "unbound:entry-context", "E_UNKNOWN_SCOPE_UPGRADE");
      const { ref, ...payload } = record;
      require(ref.revisionId === `revision:${sha(stable(payload)).slice(7)}`, "E_REVISION_CONTENT");
    }
    const dereference = ref => {
      if (!require(validRef(ref), "E_REF_SCHEMA")) return null;
      return require(byRef.has(stable(ref)), "E_REF_DANGLING") ? byRef.get(stable(ref)) : null;
    };
    const entity = ref => {
      if (!require(ref?.kind === "EntityRef" && typeof ref.id === "string" && ref.projectId === bundle.projectId, "E_ENTITY_REF")) return null;
      const found = entities.get(ref.id);
      return require(found && found.kind === ref.entityKind && found.projectId === ref.projectId, "E_ENTITY_REF") ? found : null;
    };
    const sourceMatches = (record, item) => record?.ref.kind === "Evidence" && record.extensions?.[ns]?.evidenceRole === "original-source-span"
      && record.extensions[ns].sourcePath === item.file && registrations.get(record.inputId)?.path === item.file && eq(record.locator.normalized, item.span);
    for (const envelope of bundle.envelopes || []) {
      require(envelope.schemaVersion === "0.2-draft" && envelope.snapshotId === bundle.snapshotDescriptor.id && envelope.completeness?.complete === false, "E_ENVELOPE_SCOPE");
    }
    for (const registeredEntity of entities.values()) {
      require(registeredEntity.identityKey?.snapshotId === bundle.snapshotDescriptor.id && registeredEntity.identityKey?.namespace === "snapshot-local-project-loading-anchor-v0.1"
        && registeredEntity.identityLifetime === "this captured snapshot only", "E_IDENTITY_CONTINUITY_UPGRADE");
      require(registeredEntity.id === `entity:${sha(stable(registeredEntity.identityKey)).slice(7)}`, "E_ENTITY_IDENTITY");
    }
    const relationIndices = [], declarationIndices = [], callIndices = [];
    const derivations = records.filter(record => record.ref?.kind === "Derivation");
    const outputs = new Map();
    for (const derivation of derivations) for (const output of derivation.outputFactRefs || []) {
      const key = stable(output); outputs.set(key, [...(outputs.get(key) || []), derivation]);
    }
    for (const record of records) {
      for (const field of ["evidenceRefs", "conditionRefs", "inputFactRefs", "outputFactRefs", "dependencyRefs", "affectedRefs", "sourceClosure", "supportingEvidenceRefs", "opposingEvidenceRefs", "bindingSummaryRefs"]) {
        if (Object.hasOwn(record, field)) {
          if (!require(Array.isArray(record[field]), "E_REFERENCE_ARRAY", field)) continue;
          for (const ref of record[field]) dereference(ref);
        }
      }
      if (record.completeness) {
        require(record.completeness.complete === false && record.completeness.freshness === "current", "E_COMPLETENESS_UPGRADE");
        for (const ref of record.completeness.diagnosticRefs || []) dereference(ref);
      }
      if (record.ref?.kind === "Evidence") {
        const inputRegistration = registrations.get(record.inputId);
        if (!require(inputRegistration && record.inputFingerprint === inputRegistration.sha256 && record.accessRegistrationId === inputRegistration.accessRegistrationId, "E_EVIDENCE_INPUT")) continue;
        require(record.production === "automatic" && record.semanticKind === "implementation-fact" && record.trustLabel === "untrusted-content", "E_SOURCE_PRODUCTION");
        if (record.locator?.kind === "json-pointer") {
          require(record.inputId === bundle.sourceReport.id, "E_REPORT_INPUT_IDENTITY");
          const parts = record.locator.pointer === "" ? [] : record.locator.pointer.split("/").slice(1);
          let value = raw;
          for (const part of parts) value = value?.[part];
          require(value !== undefined && record.locator.valueFingerprint === sha(stable(value)), "E_REPORT_ITEM_EVIDENCE");
        } else {
          const locator = record.locator;
          require(record.extensions?.[ns]?.sourcePath === inputRegistration.path, "E_SOURCE_IDENTITY");
          require(locator && locator.inputId === record.inputId && locator.inputFingerprint === record.inputFingerprint && locator.coordinatePolicyId === "raw-bytes-codepoints-v0.1"
            && locator.mappingStatus === "exact" && Array.isArray(locator.mappingRefs) && locator.mappingRefs.length === 0, "E_SOURCE_LOCATOR");
          require(locator && originalCoordinates(inputRegistration.bytes, locator.normalized), "E_SOURCE_COORDINATE");
          require(locator?.nativePositions?.unit === "UTF-8-byte-offset" && locator.nativePositions.tool === "CodeCartia project-loading normalized-byte report"
            && locator.nativePositions.input === inputRegistration.path && locator.nativePositions.start === locator.normalized.startByte && locator.nativePositions.end === locator.normalized.endByte, "E_INVENTED_NATIVE_COORDINATE");
        }
      }
      if (record.ref?.kind === "EntityVersion") {
        const registeredEntity = entity(record.entityRef), origin = record.extensions?.[ns];
        const item = origin?.section === "declarations" ? raw.declarations[origin.index] : origin?.section === "calls" ? raw.calls[origin.index] : null;
        if (!require(item && registeredEntity, "E_ORIGIN_RECORD")) continue;
        require(registeredEntity.identityKey.configId === record.scope.configId && configurationScopes.get(record.scope.configId) === (raw.language === "js-ts" ? item.configFile : raw.configFile), "E_CONFIGURATION_SCOPE");
        (origin.section === "declarations" ? declarationIndices : callIndices).push(origin.index);
        require(registeredEntity.identityKey.file === item.file && eq(registeredEntity.identityKey.span, item.span), "E_ENTITY_SOURCE_ANCHOR");
        require(Array.isArray(record.evidenceRefs) && record.evidenceRefs.some(ref => sourceMatches(byRef.get(stable(ref)), item)), "E_EVIDENCE_REQUIRED");
        require(record.evidenceRefs.some(ref => byRef.get(stable(ref))?.locator?.pointer === `/${origin.section}/${origin.index}`), "E_REPORT_ITEM_EVIDENCE");
        require(outputs.has(stable(record.ref)), "E_INDEPENDENT_DERIVATION_REQUIRED");
      }
      if (record.ref?.kind === "Relation") {
        const origin = record.extensions?.[ns], call = raw.calls[origin?.index];
        if (!require(call && origin.section === "calls", "E_ORIGIN_RECORD")) continue;
        relationIndices.push(origin.index);
        const source = entity(record.sourceRef);
        require(source?.kind === "call-site" && eq(source.identityKey.span, call.span) && source.identityKey.file === call.file, "E_CALL_ANCHOR");
        require(source?.identityKey.configId === record.scope.configId && configurationScopes.get(record.scope.configId) === (raw.language === "js-ts" ? call.configFile : raw.configFile), "E_CONFIGURATION_SCOPE");
        require(record.type === "reference" && origin.bindingKind === call.bindingKind && origin.runtimeTargetMode === "unknown" && origin.executionReachability === "not-evaluated", "E_RUNTIME_UPGRADE");
        if (call.resolution === "unresolved") {
          require(record.resolution === "unresolved" && record.targetMode === "unknown" && record.targetSetCompleteness === "unknown" && record.targetRefs?.length === 0, "E_UNKNOWN_UPGRADE");
        } else {
          require(record.resolution === "confirmed" && record.targetMode === "exact" && record.targetSetCompleteness === "complete" && record.targetRefs?.length === 1, "E_REFERENCE_STATE");
          const target = entity(record.targetRefs?.[0]);
          require(target?.kind === "symbol" && target.identityKey.file === call.target.file && target.identityKey.qualifiedName === call.target.qualifiedName && eq(target.identityKey.span, call.target.span), "E_WRONG_TARGET");
          require(target?.identityKey.configId === record.scope.configId, "E_CONFIGURATION_SCOPE");
          require(record.evidenceRefs?.some(ref => sourceMatches(byRef.get(stable(ref)), call.target)), "E_TARGET_DECLARATION_EVIDENCE");
        }
        require(record.evidenceRefs?.some(ref => sourceMatches(byRef.get(stable(ref)), call)), "E_EVIDENCE_REQUIRED");
        require(outputs.has(stable(record.ref)), "E_INDEPENDENT_DERIVATION_REQUIRED");
      }
      if (record.ref?.kind === "Derivation") {
        require(record.analysisMode === "static" && record.inputFactRefs?.length > 0 && record.outputFactRefs?.length === 1, "E_DERIVATION_SHAPE");
        require(record.inputFactRefs?.every(ref => ref.kind !== "EntityRef"), "E_REF_SCHEMA");
        require(record.inputFactRefs?.every(ref => eq(ref.scope, record.scope)) && record.outputFactRefs?.every(ref => eq(ref.scope, record.scope)), "E_CONFIGURATION_SCOPE");
        require(record.sourceClosure?.every(ref => byRef.get(stable(ref))?.ref.kind === "Evidence" && byRef.get(stable(ref))?.production === "automatic"), "E_SOURCE_PRODUCTION");
        const output = byRef.get(stable(record.outputFactRefs?.[0]));
        let requiredInputs = output?.evidenceRefs || [];
        if (output?.ref.kind === "Relation") {
          const endpoints = [output.sourceRef, ...(output.targetRefs || [])];
          const endpointVersions = endpoints.map(endpointRef => records.filter(candidate => candidate.ref?.kind === "EntityVersion" && eq(candidate.entityRef, endpointRef) && eq(candidate.scope, output.scope)));
          require(endpointVersions.every(candidates => candidates.length === 1), "E_REQUIRED_SEMANTIC_INPUT");
          requiredInputs = [...requiredInputs, ...endpointVersions.flat().map(version => version.ref)];
        }
        if (output?.ref.kind === "EntityVersion" || output?.ref.kind === "Relation") {
          const required = [...new Set(requiredInputs.map(stable))].sort();
          const provided = [...new Set((record.inputFactRefs || []).map(stable))].sort();
          require(eq(required, provided), "E_REQUIRED_SEMANTIC_INPUT");
        }
      }
    }
    for (const [indices, count] of [[declarationIndices, raw.declarations.length], [callIndices, raw.calls.length], [relationIndices, raw.calls.length]]) {
      require(indices.length === count && new Set(indices).size === count && indices.every(index => Number.isInteger(index) && index >= 0 && index < count), "E_FACT_CARDINALITY");
    }
    const evidenceClosure = (ref, trail = new Set()) => {
      const key = stable(ref);
      if (trail.has(key)) { require(false, "E_CAUSAL_CYCLE"); return []; }
      const fact = byRef.get(key);
      if (fact?.ref.kind === "Evidence") return [ref];
      const next = new Set(trail); next.add(key);
      return (outputs.get(key) || []).flatMap(derivation => (derivation.inputFactRefs || []).flatMap(inputRef => evidenceClosure(inputRef, next)));
    };
    const refSet = refs => [...new Set(refs.map(stable))].sort();
    for (const derivation of derivations) {
      const outputRef = derivation.outputFactRefs?.[0];
      const closure = (derivation.inputFactRefs || []).flatMap(ref => evidenceClosure(ref, new Set(outputRef ? [stable(outputRef)] : [])));
      require(eq(refSet(closure), refSet(derivation.sourceClosure || [])), "E_SOURCE_CLOSURE");
    }
    const expectedSupport = [...outputs].map(([key, supporting]) => ({ outputFactRef: JSON.parse(key), derivationRefs: supporting.map(derivation => derivation.ref) }));
    require(bundle.supportIndex?.kind === "host-query-projection" && bundle.supportIndex.fingerprint === sha(stable(bundle.supportIndex.entries)), "E_SUPPORT_PROJECTION");
    require(eq([...expectedSupport].sort((a, b) => stable(a.outputFactRef).localeCompare(stable(b.outputFactRef))), [...(bundle.supportIndex?.entries || [])].sort((a, b) => stable(a.outputFactRef).localeCompare(stable(b.outputFactRef)))), "E_SUPPORT_PROJECTION");
  }
  return issues;
}

const baseline = check(original);
if (baseline.length) {
  writeJSON("reports/verification.json", { status: "failed", baselineIssues: baseline });
  process.stderr.write(JSON.stringify(baseline.slice(0, 25), null, 2));
  process.exitCode = 1;
} else {
  const mutations = [];
  const mutate = (name, expectedCode, modify) => {
    const changed = structuredClone(original);
    modify(changed);
    let detected;
    try { detected = check(changed); } catch (error) { detected = [{ code: "E_VERIFIER_EXCEPTION", detail: error.message }]; }
    const passed = detected.some(issue => issue.code === expectedCode);
    mutations.push({ name, expectedCode, passed, detectedCodes: [...new Set(detected.map(issue => issue.code))] });
  };
  const findFact = (data, kind, predicate = () => true) => data.bundles.flatMap(bundle => bundle.records).find(record => record.ref.kind === kind && predicate(record));
  const reversionDerivation = (data, derivation, oldRef) => {
    const { ref, ...payload } = derivation;
    derivation.ref = { ...ref, revisionId: `revision:${sha(stable(payload)).slice(7)}` };
    for (const bundle of data.bundles) {
      for (const entry of bundle.supportIndex.entries) entry.derivationRefs = entry.derivationRefs.map(value => eq(value, oldRef) ? structuredClone(derivation.ref) : value);
      bundle.supportIndex.fingerprint = sha(stable(bundle.supportIndex.entries));
    }
  };
  mutate("missing-revision", "E_REF_SCHEMA", data => { delete findFact(data, "Derivation").inputFactRefs[0].revisionId; });
  mutate("wrong-exact-revision", "E_REF_DANGLING", data => { findFact(data, "Derivation").inputFactRefs[0].revisionId = "revision:wrong-version"; });
  mutate("logical-entity-used-as-proof", "E_REF_SCHEMA", data => { findFact(data, "Derivation").inputFactRefs[0] = findFact(data, "EntityVersion").entityRef; });
  mutate("deleted-evidence", "E_REF_DANGLING", data => { const bundle = data.bundles[0]; bundle.records.splice(bundle.records.findIndex(record => record.ref.kind === "Evidence"), 1); });
  mutate("relationship-without-evidence", "E_EVIDENCE_REQUIRED", data => { findFact(data, "Relation").evidenceRefs = []; });
  mutate("unknown-promoted", "E_UNKNOWN_UPGRADE", data => { const relation = findFact(data, "Relation", record => record.resolution === "unresolved"); relation.resolution = "confirmed"; relation.targetMode = "exact"; relation.targetSetCompleteness = "complete"; });
  mutate("runtime-target-promoted", "E_RUNTIME_UPGRADE", data => { findFact(data, "Relation").extensions[ns].runtimeTargetMode = "exact"; });
  mutate("wrong-target-declaration", "E_WRONG_TARGET", data => { const bundle = data.bundles.find(item => item.records.some(record => record.ref.kind === "Relation" && record.resolution === "confirmed")); const relation = bundle.records.find(record => record.ref.kind === "Relation" && record.resolution === "confirmed"); const target = bundle.entities.find(entity => entity.id === relation.targetRefs[0].id); const other = bundle.entities.find(entity => entity.kind === "symbol" && entity.identityKey.configId === relation.scope.configId && !eq(entity.identityKey.span, target.identityKey.span)); relation.targetRefs[0] = { kind: "EntityRef", entityKind: "symbol", id: other.id, projectId: bundle.projectId }; });
  mutate("same-declaration-in-wrong-config", "E_CONFIGURATION_SCOPE", data => { const bundle = data.bundles[0]; const relation = bundle.records.find(record => record.ref.kind === "Relation" && record.resolution === "confirmed"); const target = bundle.entities.find(entity => entity.id === relation.targetRefs[0].id); const other = bundle.entities.find(entity => entity.kind === "symbol" && entity.identityKey.file === target.identityKey.file && eq(entity.identityKey.span, target.identityKey.span) && entity.identityKey.configId !== target.identityKey.configId); relation.targetRefs[0] = { kind: "EntityRef", entityKind: "symbol", id: other.id, projectId: bundle.projectId }; });
  mutate("changed-source-column", "E_SOURCE_COORDINATE", data => { findFact(data, "Evidence", record => record.locator.normalized).locator.normalized.startColumn += 1; });
  mutate("source-fingerprint-forged", "E_EVIDENCE_INPUT", data => { findFact(data, "Evidence").inputFingerprint = `sha256:${"0".repeat(64)}`; });
  mutate("source-path-label-forged", "E_SOURCE_IDENTITY", data => { findFact(data, "Evidence", record => record.locator.normalized).extensions[ns].sourcePath = "another-source-file.ts"; });
  mutate("source-span-removed", "E_SOURCE_LOCATOR", data => { findFact(data, "Evidence", record => record.locator.normalized).locator.mappingStatus = "unavailable"; });
  mutate("invented-native-unit", "E_INVENTED_NATIVE_COORDINATE", data => { findFact(data, "Evidence", record => record.locator.normalized).locator.nativePositions.unit = "UTF-16-code-unit"; });
  mutate("scope-missing", "E_REF_SCHEMA", data => { delete findFact(data, "Relation").ref.scope.entryContextId; });
  mutate("scope-changed", "E_SCOPE", data => { findFact(data, "Relation").scope.configId = "other-config"; });
  mutate("foreign-snapshot-reference", "E_REF_DANGLING", data => { findFact(data, "Derivation").inputFactRefs[0].snapshotId = "different-snapshot"; });
  mutate("manual-evidence-in-static-view", "E_SOURCE_PRODUCTION", data => { findFact(data, "Evidence").production = "manual"; });
  mutate("removed-source-closure", "E_SOURCE_CLOSURE", data => { findFact(data, "Derivation").sourceClosure = []; });
  mutate("self-consistent-target-version-omitted", "E_REQUIRED_SEMANTIC_INPUT", data => {
    const derivation = findFact(data, "Derivation", record => record.outputFactRefs[0].kind === "Relation" && record.inputFactRefs.filter(ref => ref.kind === "EntityVersion").length === 2);
    const oldRef = structuredClone(derivation.ref), omitted = derivation.inputFactRefs.filter(ref => ref.kind === "EntityVersion")[1];
    derivation.inputFactRefs = derivation.inputFactRefs.filter(ref => !eq(ref, omitted));
    reversionDerivation(data, derivation, oldRef);
  });
  mutate("self-consistent-raw-evidence-input-omitted", "E_REQUIRED_SEMANTIC_INPUT", data => {
    const derivation = findFact(data, "Derivation", record => record.outputFactRefs[0].kind === "EntityVersion");
    const oldRef = structuredClone(derivation.ref), omitted = derivation.inputFactRefs[0];
    derivation.inputFactRefs = derivation.inputFactRefs.filter(ref => !eq(ref, omitted));
    derivation.evidenceRefs = derivation.evidenceRefs.filter(ref => !eq(ref, omitted));
    derivation.supportingEvidenceRefs = derivation.supportingEvidenceRefs.filter(ref => !eq(ref, omitted));
    derivation.sourceClosure = derivation.sourceClosure.filter(ref => !eq(ref, omitted));
    reversionDerivation(data, derivation, oldRef);
  });
  mutate("self-supporting-derivation", "E_CAUSAL_CYCLE", data => { const derivation = findFact(data, "Derivation"); derivation.inputFactRefs = [...derivation.outputFactRefs]; });
  mutate("backlink-written-into-payload", "E_BACKLINK_PAYLOAD", data => { findFact(data, "Relation").derivationRefs = []; });
  mutate("missing-independent-derivation", "E_INDEPENDENT_DERIVATION_REQUIRED", data => { const bundle = data.bundles[0]; const relation = bundle.records.find(record => record.ref.kind === "Relation"); bundle.records = bundle.records.filter(record => record.ref.kind !== "Derivation" || !record.outputFactRefs.some(ref => eq(ref, relation.ref))); });
  mutate("extra-call-fact", "E_FACT_CARDINALITY", data => { const bundle = data.bundles[0]; bundle.records.push(structuredClone(bundle.records.find(record => record.ref.kind === "Relation"))); });
  mutate("empty-output", "E_EMPTY_OR_EXTRA_BUNDLES", data => { data.bundles = []; });
  mutate("full-schema-upgrade", "E_BUNDLE_PROFILE", data => { data.fullSchemaConformance = true; });
  mutate("identity-lifetime-upgrade", "E_IDENTITY_CONTINUITY_UPGRADE", data => { data.bundles[0].entities[0].identityLifetime = "all-snapshots"; });
  const passed = mutations.every(result => result.passed);
  const result = { reportVersion: "project-fact-mapping-verification-v0.1", status: passed ? "checks-passed" : "checks-failed", bundleFingerprint: sha(originalBytes), registryFingerprint: sha(registryBytes),
    verifierFingerprint: sha(readBytes(fileURLToPath(import.meta.url))), projects: original.bundles.length, records: original.bundles.reduce((count, bundle) => count + bundle.records.length, 0), baselineIssues: [],
    mutationCount: mutations.length, mutationsDetected: mutations.filter(item => item.passed).length, mutations,
    boundary: "Independent reference/digest/source-coordinate checks against pure actual reports and raw inputs; not a second language analyzer or a full public-schema conformance suite." };
  writeJSON("reports/verification.json", result);
  process.stdout.write(`${JSON.stringify({ status: result.status, projects: result.projects, records: result.records, mutationsDetected: result.mutationsDetected, mutationCount: result.mutationCount })}\n`);
  if (!passed) process.exitCode = 1;
}
