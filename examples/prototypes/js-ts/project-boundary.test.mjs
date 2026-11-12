import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { test, after } from "node:test";
import { fileURLToPath } from "node:url";
import { analyzeProject, writeProjectReport } from "./project-extract.mjs";
import { reportsRoot, writeReport } from "./io-policy.mjs";

const results = [];
const unavailableChecks = [];
const fingerprint = filename => `sha256:${crypto.createHash("sha256").update(fs.readFileSync(filename)).digest("hex")}`;
const base = path.dirname(fileURLToPath(import.meta.url));
const isInside = (candidate, root) => {
  const relative = path.relative(root, candidate);
  return relative !== "" && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
};
const check = (name, action) => test(name, context => {
  try {
    const outcome = action();
    if (outcome?.skipped) { context.skip(outcome.reason); results.push({ name, passed: false, skipped: true, reason: outcome.reason }); }
    else results.push({ name, passed: true });
  }
  catch (error) { results.push({ name, passed: false, error: error.message }); throw error; }
});

function withFixture(action) {
  fs.mkdirSync(reportsRoot, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(reportsRoot, "project-boundary-"));
  const root = path.join(temporary, "project");
  const links = [];
  const put = (relative, text) => {
    const target = path.resolve(temporary, relative);
    assert.ok(isInside(target, temporary));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
    return target;
  };
  const link = (target, location, type = "junction") => { fs.symlinkSync(target, location, type); links.push(location); };
  put("project/tsconfig.json", JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "bundler", types: [] }, include: ["src/**/*"] }));
  put("project/src/main.ts", "export function identity(value: number) { return value; }\nexport const result = identity(7);\n");
  const request = extra => ({ projectId: "boundary-fixture", projectRoot: root, ...extra });
  try { return action({ root, temporary, put, link, request }); }
  finally {
    for (const location of links.reverse()) {
      try { if (fs.lstatSync(location).isSymbolicLink()) fs.unlinkSync(location); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    const real = fs.realpathSync(temporary);
    assert.equal(fs.lstatSync(temporary).isSymbolicLink(), false);
    assert.ok(isInside(real, fs.realpathSync(reportsRoot)), "Cleanup must remain inside this experiment's report directory.");
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

check("same source retains two project configuration bindings", () => withFixture(({ put, request }) => {
  put("project/tsconfig.json", JSON.stringify({ files: [], references: [{ path: "first" }, { path: "second" }] }));
  put("project/shared.ts", 'import { transform } from "@mode";\nexport const result = transform(1);\n');
  put("project/first-target.ts", "export function transform(value: number) { return value + 1; }\n");
  put("project/second-target.ts", "export function transform(value: number) { return value + 2; }\n");
  for (const name of ["first", "second"]) {
    put(`project/${name}/tsconfig.json`, JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "bundler", types: [],
      composite: true, rootDir: "..", paths: { "@mode": [`../${name}-target.ts`] } }, files: ["../shared.ts", `../${name}-target.ts`] }));
  }
  const report = analyzeProject(request());
  const calls = report.calls.filter(call => call.file === "shared.ts");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => [call.configFile, call.target?.file]).sort(), [["first/tsconfig.json", "first-target.ts"], ["second/tsconfig.json", "second-target.ts"]]);
  assert.ok(calls.every(call => call.runtimeTargetMode === "unknown" && call.resolution === "confirmed"));
}));

check("explicit extensionless JavaScript enters the program and binds imported and local calls", () => withFixture(({ put, request }) => {
  const entryText = '#!/usr/bin/env node\nimport { double } from "./helpers.js";\nfunction local(value) { return double(value); }\nexport const answer = local(21);\n';
  const entryPath = put("project/tools/launch", entryText);
  put("project/tools/helpers.js", "export function double(value) { return value * 2; }\n");
  const untouched = analyzeProject(request());
  assert.ok(!untouched.inputManifest.some(input => input.path === "tools/launch"));
  const report = analyzeProject(request({ additionalEntryFiles: [{ path: "tools/launch", language: "javascript" }] }));
  const entry = report.additionalEntryFiles[0];
  assert.equal(entry.programIncluded, true);
  assert.equal(entry.nativeScriptKind, "JS");
  assert.equal(entry.configFile, "tsconfig.json");
  assert.equal(entry.inputSha256, fingerprint(entryPath));
  assert.equal(report.inputManifest.find(input => input.path === "tools/launch")?.sourceKind, "javascript");
  assert.equal(report.configurations[0].analysisOverrides.allowNonTsExtensions, true);
  assert.equal(report.imports.find(item => item.file === "tools/launch" && item.moduleSpecifier === "./helpers.js")?.targetFile, "tools/helpers.js");
  const calls = report.calls.filter(call => call.file === "tools/launch");
  assert.deepEqual(calls.map(call => [call.callee, call.resolution, call.target?.file]).sort(), [["double", "confirmed", "tools/helpers.js"], ["local", "confirmed", "tools/launch"]]);
  const local = calls.find(call => call.callee === "local");
  assert.equal(Buffer.from(entryText).subarray(local.span.startByte, local.span.endByte).toString(), "local(21)");
  assert.equal(Buffer.from(entryText).subarray(local.target.span.startByte, local.target.span.endByte).toString(), "function local(value) { return double(value); }");
  assert.ok(calls.every(call => call.runtimeTargetMode === "unknown"));
}));

check("additional sources are added only to the primary configuration", () => withFixture(({ put, request }) => {
  put("project/tsconfig.json", JSON.stringify({ files: [], references: [{ path: "core" }], compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "bundler", types: [] } }));
  put("project/core/tsconfig.json", JSON.stringify({ compilerOptions: { composite: true, types: [] }, files: ["value.ts"] }));
  put("project/core/value.ts", "export const value = 1;\n");
  put("project/runner", "function local() { return 1; }\nlocal();\n");
  const report = analyzeProject(request({ additionalEntryFiles: [{ path: "runner", language: "javascript" }] }));
  assert.equal(report.additionalEntryFiles[0].programIncluded, true);
  assert.deepEqual(report.calls.filter(call => call.file === "runner").map(call => call.configFile), ["tsconfig.json"]);
  assert.ok(!report.configurations.find(config => config.configFile === "core/tsconfig.json").files.includes("runner"));
}));

check("an explicit source does not permit reading other extensionless imports", () => withFixture(({ put, request }) => {
  put("project/tools/launch", 'import { hidden } from "./hidden";\nhidden();\n');
  put("project/tools/hidden", "export function hidden() { return 1; }\n");
  const report = analyzeProject(request({ additionalEntryFiles: [{ path: "tools/launch", language: "javascript" }] }));
  assert.ok(!report.inputManifest.some(input => input.path === "tools/hidden"));
  assert.equal(report.calls.find(call => call.file === "tools/launch" && call.callee === "hidden")?.target, null);
  assert.equal(report.completeness.complete, false);
}));

check("unsupported entry languages and ordinary non-JavaScript file types are refused", () => withFixture(({ put, request }) => {
  put("project/runner", "print(1)\n");
  put("project/data.py", "print(2)\n");
  const report = analyzeProject(request({ additionalEntryFiles: [{ path: "runner", language: "python" }, { path: "data.py", language: "javascript" }] }));
  assert.ok(report.additionalEntryFiles.every(entry => entry.status === "rejected" && !entry.programIncluded));
  assert.ok(!report.inputManifest.some(input => ["runner", "data.py"].includes(input.path)));
  assert.ok(report.diagnostics.some(diagnostic => diagnostic.code === "ADDITIONAL_ENTRY_KIND_UNSUPPORTED"));
  assert.equal(report.completeness.complete, false);
}));

check("additional entry paths cannot escape the registered root", () => withFixture(({ temporary, put, request }) => {
  const protectedFile = put("outside", "function external() { return 1; }\n");
  const before = fingerprint(protectedFile);
  const report = analyzeProject(request({ additionalEntryFiles: [{ path: "../outside", language: "javascript" }, { path: path.join(temporary, "outside"), language: "javascript" }] }));
  assert.ok(report.additionalEntryFiles.every(entry => !entry.programIncluded));
  assert.equal(report.diagnostics.filter(diagnostic => diagnostic.code === "ADDITIONAL_ENTRY_OUTSIDE_ROOT").length, 2);
  assert.equal(fingerprint(protectedFile), before);
}));

check("additional entry directory junctions are refused before reading", () => withFixture(({ root, temporary, put, link, request }) => {
  const protectedFile = put("protected/runner", "function external() { return 1; }\nexternal();\n");
  link(path.join(temporary, "protected"), path.join(root, "linked-tools"));
  const before = fingerprint(protectedFile);
  const report = analyzeProject(request({ additionalEntryFiles: [{ path: "linked-tools/runner", language: "javascript" }] }));
  assert.equal(report.additionalEntryFiles[0].programIncluded, false);
  assert.ok(!report.inputManifest.some(input => input.path === "linked-tools/runner"));
  assert.ok(report.diagnostics.some(diagnostic => diagnostic.code === "INPUT_LINK_REFUSED"));
  assert.equal(fingerprint(protectedFile), before);
}));

check("a non-Node shebang is not treated as JavaScript", () => withFixture(({ put, request }) => {
  put("project/runner", "#!/usr/bin/env python\nprint(1)\n");
  const report = analyzeProject(request({ additionalEntryFiles: [{ path: "runner", language: "javascript" }] }));
  assert.equal(report.additionalEntryFiles[0].programIncluded, false);
  assert.equal(report.additionalEntryFiles[0].status, "rejected");
  assert.ok(report.diagnostics.some(diagnostic => diagnostic.code === "ADDITIONAL_ENTRY_SHEBANG_UNSUPPORTED"));
  assert.ok(!report.calls.some(call => call.file === "runner"));
}));

check("explicit entry capture still enforces UTF-8 and file budgets", () => withFixture(({ put, request }) => {
  put("project/invalid", Buffer.from([0xff, 0x0a]));
  put("project/large", `function large() { return "${"x".repeat(4096)}"; }\n`);
  const report = analyzeProject(request({ additionalEntryFiles: [{ path: "invalid", language: "javascript" }, { path: "large", language: "javascript" }], limits: { maxFileBytes: 2048 } }));
  assert.ok(report.additionalEntryFiles.every(entry => !entry.programIncluded));
  assert.ok(report.diagnostics.some(diagnostic => diagnostic.code === "INVALID_UTF8"));
  assert.ok(report.completeness.truncations.some(item => item.limitName === "maxFileBytes"));
  assert.equal(report.completeness.complete, false);
}));

check("absolute and escaping configuration requests are refused", () => withFixture(({ root, request }) => {
  assert.throws(() => analyzeProject(request({ configFile: path.join(root, "tsconfig.json") })), /relative path/);
  assert.throws(() => analyzeProject(request({ configFile: "../outside.json" })), /relative path/);
}));

check("imports and extended configuration cannot read outside projectRoot", () => withFixture(({ put, request }) => {
  const protectedFile = put("outside.ts", "export function outside() { return 'protected'; }\n");
  put("outside.json", JSON.stringify({ compilerOptions: { strict: true } }));
  put("project/tsconfig.json", JSON.stringify({ extends: "../outside.json", compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "bundler", types: [] }, include: ["src/**/*"] }));
  put("project/src/main.ts", 'import { outside } from "../../outside";\nexport const result = outside();\n');
  const before = fingerprint(protectedFile);
  const report = analyzeProject(request());
  assert.equal(report.completeness.complete, false);
  assert.ok(report.inputManifest.every(input => input.kind === "toolchain" || !path.isAbsolute(input.path) && !input.path.startsWith("..")));
  assert.ok(!report.inputManifest.some(input => input.path.endsWith("outside.json") || input.path.endsWith("outside.ts")));
  assert.equal(report.calls.find(call => call.callee === "outside")?.resolution, "unresolved");
  assert.equal(fingerprint(protectedFile), before);
}));

check("a junction used as projectRoot is refused", () => withFixture(({ root, temporary, link, request }) => {
  const alias = path.join(temporary, "project-alias");
  link(root, alias);
  assert.throws(() => analyzeProject(request({ projectRoot: alias })), /link/);
}));

check("a configuration behind a directory junction is refused", () => withFixture(({ root, temporary, put, link, request }) => {
  put("protected-config/tsconfig.json", '{"files":[]}\n');
  link(path.join(temporary, "protected-config"), path.join(root, "linked-config"));
  assert.throws(() => analyzeProject(request({ configFile: "linked-config/tsconfig.json" })), /link/);
}));

check("directory junctions cannot supply imported source", () => withFixture(({ root, temporary, put, link, request }) => {
  const protectedFile = put("protected/value.ts", "export function outside() { return 'protected'; }\n");
  put("project/src/main.ts", 'import { outside } from "./linked/value";\nexport const result = outside();\n');
  link(path.join(temporary, "protected"), path.join(root, "src", "linked"));
  const before = fingerprint(protectedFile);
  const report = analyzeProject(request());
  assert.equal(report.completeness.complete, false);
  assert.ok(report.diagnostics.some(diagnostic => diagnostic.code === "INPUT_LINK_REFUSED" || diagnostic.code === "MODULE_RESOLUTION_FAILED"));
  assert.ok(!report.inputManifest.some(input => input.path.includes("linked/value.ts") || input.path.endsWith("protected/value.ts")));
  assert.equal(report.calls.find(call => call.callee === "outside")?.target, null);
  assert.equal(fingerprint(protectedFile), before);
}));

check("final file symlinks are refused when the host permits their creation", () => withFixture(({ root, put, link, request }) => {
  const protectedFile = put("protected.ts", "export function protectedValue() { return 1; }\n");
  const alias = path.join(root, "src", "alias.ts");
  try { link(protectedFile, alias, "file"); }
  catch (error) {
    if (error.code !== "EPERM" && error.code !== "EACCES") throw error;
    unavailableChecks.push({ name: "actual file symbolic link", reason: error.code, completed: false });
    return { skipped: true, reason: `File symlink creation is unavailable: ${error.code}` };
  }
  const additionalAlias = path.join(root, "explicit-alias");
  link(protectedFile, additionalAlias, "file");
  const report = analyzeProject(request({ additionalEntryFiles: [{ path: "explicit-alias", language: "javascript" }] }));
  assert.ok(!report.inputManifest.some(input => input.path === "src/alias.ts"));
  assert.ok(report.diagnostics.some(diagnostic => diagnostic.code === "INPUT_LINK_REFUSED"));
  assert.ok(!report.inputManifest.some(input => input.path === "explicit-alias"));
  assert.equal(report.additionalEntryFiles[0].programIncluded, false);
}));

check("reports cannot overwrite any file in the analyzed project", () => withFixture(({ root, request }) => {
  const inputConfig = path.join(root, "tsconfig.json");
  const before = fingerprint(inputConfig);
  assert.throws(() => writeProjectReport(request(), inputConfig), /analyzed project/);
  assert.equal(fingerprint(inputConfig), before);
}));

check("report parent and final-path junctions are refused", () => withFixture(({ temporary, put, link, request }) => {
  const protectedFile = put("protected-output/sentinel.json", '{"protected":true}\n');
  const parentAlias = path.join(temporary, "output-link");
  const finalAlias = path.join(temporary, "final-link.json");
  link(path.join(temporary, "protected-output"), parentAlias);
  link(path.join(temporary, "protected-output"), finalAlias);
  const before = fingerprint(protectedFile);
  assert.throws(() => writeProjectReport(request(), path.join(parentAlias, "sentinel.json")), /链接|link/);
  assert.throws(() => writeProjectReport(request(), finalAlias), /链接|link/);
  assert.equal(fingerprint(protectedFile), before);
}));

check("an existing input package cannot be overwritten by an output alias", () => withFixture(({ root, put, request }) => {
  const inputPackage = put("project/package.json", '{"type":"module","scripts":{"build":"not-run"}}\n');
  assert.throws(() => writeProjectReport(request(), path.join(root, "src", "..", "package.json")), /analyzed project/);
  assert.deepEqual(JSON.parse(fs.readFileSync(inputPackage, "utf8")), { type: "module", scripts: { build: "not-run" } });
}));

check("output hard links cannot overwrite protected input bytes", () => withFixture(({ temporary, put, request }) => {
  const protectedFile = put("project/protected.json", '{"protected":true}\n');
  const alias = path.join(temporary, "hard-linked-output.json");
  fs.linkSync(protectedFile, alias);
  assert.ok(fs.statSync(alias).nlink > 1);
  const before = fingerprint(protectedFile);
  assert.throws(() => writeProjectReport(request(), alias), /硬链接/);
  assert.throws(() => writeReport(alias, { overwritten: true }), /硬链接/);
  assert.equal(fingerprint(protectedFile), before);
}));

for (const [limitName, limit] of [["maxNodes", 1], ["maxFiles", 1], ["maxTotalBytes", 1], ["maxDirectories", 1], ["maxDirectoryEntries", 1], ["maxQueries", 1]]) {
  check(`${limitName} exhaustion is explicit and never complete`, () => withFixture(({ request }) => {
    const report = analyzeProject(request({ limits: { [limitName]: limit } }));
    assert.equal(report.completeness.complete, false);
    assert.ok(report.completeness.truncations.some(item => item.limitName === limitName));
    if (limitName === "maxNodes") assert.ok(report.budgetObservation.visitedNodes <= limit);
    if (limitName === "maxFiles") assert.ok(report.inputManifest.length <= limit);
    if (limitName === "maxTotalBytes") assert.ok(report.budgetObservation.capturedBytes <= limit);
    if (limitName === "maxQueries") assert.ok(report.readObservations.length <= limit);
  }));
}

check("project-reference expansion obeys its project budget", () => withFixture(({ put, request }) => {
  put("project/tsconfig.json", JSON.stringify({ files: [], references: [{ path: "core" }] }));
  put("project/core/tsconfig.json", JSON.stringify({ compilerOptions: { composite: true }, files: ["value.ts"] }));
  put("project/core/value.ts", "export const value = 1;\n");
  const report = analyzeProject(request({ limits: { maxProjects: 1 } }));
  assert.equal(report.completeness.complete, false);
  assert.ok(report.completeness.truncations.some(item => item.limitName === "maxProjects"));
  assert.equal(report.configurations.length, 1);
}));

check("oversized original input is refused before parsing", () => withFixture(({ put, request }) => {
  put("project/src/main.ts", `export const content = "${"x".repeat(2048)}";\n`);
  const report = analyzeProject(request({ limits: { maxFileBytes: 512 } }));
  assert.equal(report.completeness.complete, false);
  assert.ok(report.completeness.truncations.some(item => item.limitName === "maxFileBytes"));
  assert.ok(!report.inputManifest.some(input => input.path === "src/main.ts"));
}));

check("malformed UTF-8 keeps an input fingerprint but cannot yield source facts", () => withFixture(({ put, request }) => {
  put("project/src/main.ts", Buffer.from([0x65, 0x78, 0xff, 0x0a]));
  const report = analyzeProject(request());
  assert.equal(report.completeness.complete, false);
  assert.ok(report.inputManifest.some(input => input.path === "src/main.ts" && input.sizeBytes === 4));
  assert.ok(report.diagnostics.some(diagnostic => diagnostic.code === "INVALID_UTF8"));
  assert.equal(report.calls.length, 0);
}));

check("invalid exploration budgets are rejected", () => withFixture(({ request }) => {
  assert.throws(() => analyzeProject(request({ limits: { maxNodes: 0 } })), /limit/);
  assert.throws(() => analyzeProject(request({ limits: { unknownBudget: 1 } })), /limit/);
}));

after(() => writeReport("reports/project-boundary-verification.json", {
  reportVersion: "project-loading-boundary-v0.1", status: results.every(result => result.passed || result.skipped) ? "checks-passed" : "checks-failed",
  scope: "Local static loading and filesystem/resource boundaries; separate from independent semantic fixtures and product acceptance.",
  nodeVersion: process.version, platform: process.platform, extractorSha256: fingerprint(path.join(base, "project-extract.mjs")),
  testSha256: fingerprint(fileURLToPath(import.meta.url)), policySha256: fingerprint(path.join(base, "io-policy.mjs")), passed: results.filter(result => result.passed).length, total: results.length, skipped: results.filter(result => result.skipped).length, results, unavailableChecks,
}));
