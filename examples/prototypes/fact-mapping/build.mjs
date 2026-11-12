import path from "node:path";
import { base, normalize, hash, readBytes, writeJSON } from "./io.mjs";
import { mapReport, profileId } from "./mapping.mjs";

const registryBytes = readBytes(path.join(base, "inputs.json"));
const registry = JSON.parse(registryBytes.toString("utf8"));
if (registry.inputRegistryVersion !== "project-fact-mapping-inputs-v0.1" || !Array.isArray(registry.cases) || !registry.cases.length) throw new Error("INVALID_MAPPING_INPUT_REGISTRY");
const bundles = registry.cases.map(mapReport);
const generatorFingerprints = Object.fromEntries(["build.mjs", "mapping.mjs", "io.mjs"].map(file => [file, hash(readBytes(path.join(base, file)))]));
const result = { schemaVersion: "0.2-draft", subsetProfileId: profileId, fullSchemaConformance: false, registryFingerprint: hash(registryBytes), generatorFingerprints, bundles };
const output = writeJSON("reports/bundles.json", result, registry.cases.map(entry => path.resolve(base, entry.projectRoot)));
process.stdout.write(`${JSON.stringify({ output: normalize(output), bundles: bundles.length, records: bundles.reduce((count, bundle) => count + bundle.records.length, 0), fullSchemaConformance: false })}\n`);
