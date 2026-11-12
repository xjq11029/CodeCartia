import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { reportPath, writeReport } from "./io-policy.mjs";

const base = path.dirname(fileURLToPath(import.meta.url));
const normalize = value => value.replaceAll("\\", "/");
const digest = value => `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
const within = (candidate, root) => {
  const relative = path.relative(root, candidate);
  return relative === "" || !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
};

// These are exploration limits, not frozen product budgets. No target code is loaded.
const explorationDefaults = Object.freeze({
  maxFiles: 2048, maxFileBytes: 8 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024,
  maxNodes: 300000, maxProjects: 32, maxDirectories: 4096, maxDirectoryEntries: 50000,
  maxQueries: 100000,
});

function assertNoLinks(absolute) {
  for (let cursor = absolute; ; cursor = path.dirname(cursor)) {
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`Input/output path traverses a link: ${cursor}`);
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    }
    if (cursor === path.dirname(cursor)) break;
  }
}

function loadToolchain() {
  const registrationBytes = fs.readFileSync(path.join(base, "toolchain.windows-observed.json"));
  const registration = JSON.parse(registrationBytes.toString("utf8"));
  const modulePath = fs.realpathSync(registration.typescriptModule);
  const ts = createRequire(import.meta.url)(modulePath);
  if (ts.version !== registration.observedVersion) throw new Error("The registered TypeScript version changed; re-register the observed toolchain first.");
  return { ts, modulePath, libRoot: path.dirname(modulePath), registration, registrationBytes };
}

/** Read an explicitly bounded project as text, without imports, builds or compiler emit. */
export function analyzeProject(request) {
  if (!request || typeof request.projectId !== "string" || !request.projectId.trim()) throw new Error("projectId is required.");
  if (typeof request.projectRoot !== "string" || !path.isAbsolute(request.projectRoot)) throw new Error("projectRoot must be an absolute directory.");
  const requestedRoot = path.resolve(request.projectRoot);
  assertNoLinks(requestedRoot);
  if (!fs.statSync(requestedRoot).isDirectory()) throw new Error("projectRoot is not a directory.");
  const root = fs.realpathSync(requestedRoot);
  if (request.configFile !== undefined && (typeof request.configFile !== "string" || !request.configFile || path.isAbsolute(request.configFile) || !within(path.resolve(root, request.configFile), root))) {
    throw new Error("configFile must be a nonempty relative path inside projectRoot.");
  }
  if (request.configFile !== undefined) assertNoLinks(path.resolve(root, request.configFile));
  if (request.additionalEntryFiles !== undefined && !Array.isArray(request.additionalEntryFiles)) throw new Error("additionalEntryFiles must be an array of explicit source registrations.");
  const limits = { ...explorationDefaults, ...request.limits };
  for (const [name, value] of Object.entries(limits)) {
    if (!(name in explorationDefaults) || !Number.isSafeInteger(value) || value < 1) throw new Error(`Unsupported exploration limit: ${name}`);
  }
  const started = performance.now();
  const { ts, modulePath, libRoot, registration, registrationBytes } = loadToolchain();
  const caseSensitive = ts.sys.useCaseSensitiveFileNames;
  const canonical = filename => caseSensitive ? path.resolve(filename) : path.resolve(filename).toLowerCase();
  const display = filename => within(path.resolve(filename), root) ? normalize(path.relative(root, path.resolve(filename))) || "." : normalize(path.resolve(filename));
  const diagnostics = [];
  const diagnosticKeys = new Set();
  const missingInputs = new Set();
  const unsupportedModes = new Set();
  const truncations = [];
  const captures = new Map();
  const queries = new Map();
  const directoryCache = new Map();
  const additionalEntries = new Map();
  const additionalEntryRecords = [];
  let totalBytes = 0, directoryEntries = 0, visitedNodes = 0;
  const addDiagnostic = (code, message, file, extra = {}) => {
    const diagnostic = { code, message, ...(file ? { file: display(file) } : {}), ...extra };
    const key = JSON.stringify(diagnostic);
    if (!diagnosticKeys.has(key)) { diagnosticKeys.add(key); diagnostics.push(diagnostic); }
  };
  const truncate = (name, observed, file) => {
    if (!truncations.some(item => item.limitName === name)) {
      truncations.push({ limitName: name, limit: limits[name], observed, ...(file ? { file: display(file) } : {}) });
      addDiagnostic("EXPLORATION_LIMIT", `Exploration budget ${name} reached; affected input is incomplete.`, file, { limitName: name, observed, limit: limits[name] });
    }
  };
  const registerQuery = (filename, kind, outcome) => {
    const key = `${kind}:${canonical(filename)}`;
    if (!queries.has(key) && queries.size >= limits.maxQueries) { truncate("maxQueries", queries.size, filename); return false; }
    queries.set(key, { path: display(filename), kind, outcome });
    return true;
  };
  const permittedPath = (filename, diagnose = false) => {
    const absolute = path.resolve(filename);
    const registeredLibrary = absolute === libRoot || path.dirname(absolute) === libRoot && /^lib(?:\..+)?\.d\.ts$/i.test(path.basename(absolute));
    const allowedRoot = within(absolute, root) ? root : registeredLibrary ? libRoot : null;
    if (!allowedRoot) {
      registerQuery(absolute, "boundary", "outside-registered-roots");
      if (diagnose) addDiagnostic("INPUT_OUTSIDE_ROOT", "A requested input is outside the registered project and compiler-library roots.", absolute);
      return null;
    }
    try {
      let cursor = absolute;
      while (within(cursor, allowedRoot)) {
        try {
          if (fs.lstatSync(cursor).isSymbolicLink()) {
            registerQuery(absolute, "boundary", "link-refused");
            if (diagnose) addDiagnostic("INPUT_LINK_REFUSED", "Input paths containing symbolic links or directory junctions are not loaded.", absolute);
            return null;
          }
        } catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error; }
        if (cursor === allowedRoot) break;
        cursor = path.dirname(cursor);
      }
      return absolute;
    } catch (error) {
      if (diagnose) addDiagnostic("INPUT_ACCESS_FAILED", error.message, absolute);
      return null;
    }
  };
  const fileExists = filename => {
    const absolute = permittedPath(filename);
    if (!absolute) return false;
    if (queries.size >= limits.maxQueries && !queries.has(`file:${canonical(absolute)}`)) { truncate("maxQueries", queries.size, absolute); return false; }
    let exists = false;
    try { exists = fs.lstatSync(absolute).isFile(); } catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTDIR") addDiagnostic("INPUT_ACCESS_FAILED", error.message, absolute); }
    return registerQuery(absolute, "file", exists ? "present" : "missing") && exists;
  };
  const directoryExists = filename => {
    const absolute = permittedPath(filename);
    if (!absolute) return false;
    if (queries.size >= limits.maxQueries && !queries.has(`directory:${canonical(absolute)}`)) { truncate("maxQueries", queries.size, absolute); return false; }
    let exists = false;
    try { exists = fs.lstatSync(absolute).isDirectory(); } catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTDIR") addDiagnostic("INPUT_ACCESS_FAILED", error.message, absolute); }
    return registerQuery(absolute, "directory", exists ? "present" : "missing") && exists;
  };
  const readText = filename => {
    const absolute = permittedPath(filename, true);
    if (!absolute) return undefined;
    const key = canonical(absolute);
    if (captures.has(key)) return captures.get(key).text;
    if (!registerQuery(absolute, "read", "requested")) return undefined;
    if (captures.size >= limits.maxFiles) { truncate("maxFiles", captures.size, absolute); return undefined; }
    if (!/\.(?:[cm]?[jt]sx?|json)$/i.test(absolute) && !additionalEntries.has(key)) {
      addDiagnostic("INPUT_TYPE_UNSUPPORTED", "Only static JSON and JavaScript/TypeScript source inputs are read.", absolute);
      return undefined;
    }
    let descriptor;
    try {
      descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const before = fs.fstatSync(descriptor);
      if (!before.isFile()) return undefined;
      if (before.size > limits.maxFileBytes) { truncate("maxFileBytes", before.size, absolute); return undefined; }
      if (totalBytes + before.size > limits.maxTotalBytes) { truncate("maxTotalBytes", totalBytes + before.size, absolute); return undefined; }
      const bytes = fs.readFileSync(descriptor);
      const after = fs.fstatSync(descriptor);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== before.size) {
        addDiagnostic("INPUT_CHANGED_DURING_READ", "The file changed while its original bytes were captured.", absolute);
        return undefined;
      }
      let text;
      try {
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
        if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error("Input cannot round-trip as UTF-8.");
      } catch (error) { addDiagnostic("INVALID_UTF8", error.message, absolute); }
      const kind = within(absolute, libRoot) ? "toolchain" : path.basename(absolute) === "package.json" ? "metadata" : /\.json$/i.test(absolute) ? "config" : "source";
      captures.set(key, { absolute, bytes, text, kind, size: after.size, mtimeMs: after.mtimeMs, ino: after.ino, dev: after.dev });
      totalBytes += bytes.length;
      registerQuery(absolute, "read", text === undefined ? "invalid-encoding" : "captured");
      return text;
    } catch (error) {
      registerQuery(absolute, "read", error.code || "failed");
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") addDiagnostic("INPUT_ACCESS_FAILED", error.message, absolute);
      return undefined;
    } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  };
  const getFileSystemEntries = dirname => {
    const absolute = permittedPath(dirname, true);
    if (!absolute) return { files: [], directories: [] };
    const key = canonical(absolute);
    if (directoryCache.has(key)) return directoryCache.get(key);
    if (directoryCache.size >= limits.maxDirectories) { truncate("maxDirectories", directoryCache.size, absolute); return { files: [], directories: [] }; }
    const result = { files: [], directories: [] };
    try {
      for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
        if (directoryEntries >= limits.maxDirectoryEntries) { truncate("maxDirectoryEntries", directoryEntries, absolute); break; }
        directoryEntries++;
        if (entry.isSymbolicLink()) {
          addDiagnostic("INPUT_LINK_REFUSED", "A directory scan omitted a symbolic link or junction.", path.join(absolute, entry.name));
        } else if (entry.isDirectory()) result.directories.push(entry.name);
        else if (entry.isFile()) result.files.push(entry.name);
      }
      registerQuery(absolute, "enumeration", "captured");
    } catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTDIR") addDiagnostic("INPUT_ACCESS_FAILED", error.message, absolute); }
    directoryCache.set(key, result);
    return result;
  };
  const safeRealpath = filename => permittedPath(filename) || path.resolve(filename);
  const readDirectory = (dirname, extensions, excludes, includes, depth) => ts.matchFiles(dirname, extensions, excludes, includes, caseSensitive, root, depth, getFileSystemEntries, safeRealpath);

  // An explicit technical declaration allows this one extensionless input; it
  // never broadens file-type admission for other files or evaluates a command.
  for (const [index, entry] of (request.additionalEntryFiles || []).entries()) {
    const observation = { registrationIndex: index, path: typeof entry?.path === "string" ? entry.path : null,
      language: typeof entry?.language === "string" ? entry.language : null, registrationOrigin: "explicit-request", programIncluded: false, status: "rejected" };
    additionalEntryRecords.push(observation);
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.path !== "string" || !entry.path) {
      addDiagnostic("ADDITIONAL_ENTRY_INVALID", "An additional entry requires a relative path and an explicit javascript language declaration.", null, { registrationIndex: index });
      unsupportedModes.add("invalid-additional-entry");
      continue;
    }
    if (path.isAbsolute(entry.path) || entry.path.split(/[\\/]/).some(part => part === ".." || part.includes(":")) || !within(path.resolve(root, entry.path), root) || path.resolve(root, entry.path) === root) {
      addDiagnostic("ADDITIONAL_ENTRY_OUTSIDE_ROOT", "Additional entries must be non-root relative paths within projectRoot.", null, { registrationIndex: index, requestedPath: entry.path });
      unsupportedModes.add("invalid-additional-entry");
      continue;
    }
    const absolute = path.resolve(root, entry.path), key = canonical(absolute);
    observation.path = display(absolute);
    if (entry.language !== "javascript" || path.extname(absolute) !== "") {
      addDiagnostic("ADDITIONAL_ENTRY_KIND_UNSUPPORTED", "This exploration registration only admits explicitly declared extensionless JavaScript sources.", absolute);
      unsupportedModes.add("additional-entry-source-kind");
      continue;
    }
    if (additionalEntries.has(key)) {
      addDiagnostic("ADDITIONAL_ENTRY_DUPLICATE", "The same additional entry was registered more than once.", absolute);
      unsupportedModes.add("duplicate-additional-entry");
      continue;
    }
    if (!permittedPath(absolute, true)) continue;
    if (!fileExists(absolute)) {
      missingInputs.add(display(absolute));
      addDiagnostic("ADDITIONAL_ENTRY_MISSING", "The registered entry is absent or is not a regular file.", absolute);
      continue;
    }
    const descriptor = { absolute, observation, valid: false };
    additionalEntries.set(key, descriptor);
    const text = readText(absolute);
    if (text === undefined) {
      observation.status = "unreadable";
      addDiagnostic("ADDITIONAL_ENTRY_UNREADABLE", "The entry could not be captured as bounded, lossless UTF-8 source.", absolute);
      continue;
    }
    const firstLine = text.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/, 1)[0];
    if (firstLine.startsWith("#!")) {
      observation.shebang = firstLine;
      const nodeShebang = /^#![ \t]*\/(?:[^ \t\r\n]+\/)*(?:node(?:js)?(?:[ \t]|$)|env[ \t]+(?:-S[ \t]+)?node(?:js)?(?:[ \t]|$))/;
      if (!nodeShebang.test(firstLine)) {
        addDiagnostic("ADDITIONAL_ENTRY_SHEBANG_UNSUPPORTED", "The explicit JavaScript registration conflicts with an unsupported non-Node shebang.", absolute);
        unsupportedModes.add("additional-entry-shebang");
        continue;
      }
    }
    descriptor.valid = true;
    observation.status = "captured";
    observation.sourceKind = "javascript";
    observation.inputSha256 = digest(captures.get(key).bytes);
  }

  const coordinateAt = (text, position) => {
    if (!Number.isInteger(position) || position < 0 || position > text.length) throw new Error("Native coordinate is outside captured text.");
    if (position > 0 && position < text.length) {
      const a = text.charCodeAt(position - 1), b = text.charCodeAt(position);
      if (a >= 0xd800 && a <= 0xdbff && b >= 0xdc00 && b <= 0xdfff || a === 13 && b === 10) throw new Error("Coordinate splits a Unicode code point or CRLF.");
    }
    let line = 1, column = 1;
    for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < position;) {
      const cp = text.codePointAt(i);
      if (cp === 13 || cp === 10) { i += cp === 13 && text.charCodeAt(i + 1) === 10 ? 2 : 1; line++; column = 1; }
      else { i += cp > 0xffff ? 2 : 1; column++; }
    }
    return { byte: Buffer.byteLength(text.slice(0, position), "utf8"), line, column };
  };
  const sourceSpan = (sf, start, end) => {
    const capture = captures.get(canonical(sf.fileName));
    if (!capture || capture.text !== sf.text) throw new Error("SourceFile does not match its captured original bytes.");
    const a = coordinateAt(capture.text, start), b = coordinateAt(capture.text, end);
    return { startByte: a.byte, endByte: b.byte, startLine: a.line, startColumn: a.column, endLine: b.line, endColumn: b.column };
  };
  const spanOf = node => sourceSpan(node.getSourceFile(), node.getStart(), node.getEnd());
  const recordNativeDiagnostic = (diagnostic, configFile) => {
    const extra = { category: ts.DiagnosticCategory[diagnostic.category], ...(configFile ? { configFile } : {}) };
    if (diagnostic.file && Number.isInteger(diagnostic.start)) {
      try { extra.span = sourceSpan(diagnostic.file, diagnostic.start, diagnostic.start + (diagnostic.length || 0)); }
      catch (error) { addDiagnostic("COORDINATE_MAPPING_UNAVAILABLE", error.message, diagnostic.file.fileName); }
    }
    addDiagnostic(`TS${diagnostic.code}`, ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"), diagnostic.file?.fileName, extra);
  };
  const parseHost = { useCaseSensitiveFileNames: caseSensitive, readFile: readText, fileExists, readDirectory, directoryExists, getDirectories: dir => getFileSystemEntries(dir).directories,
    getCurrentDirectory: () => root, onUnRecoverableConfigFileDiagnostic: diagnostic => recordNativeDiagnostic(diagnostic) };
  const parsedConfigurations = new Map();
  const configurationStack = new Set();
  const configurationRecords = [];
  const packageMetadata = [];
  const rootPackagePath = path.join(root, "package.json");
  if (fileExists(rootPackagePath)) {
    const text = readText(rootPackagePath);
    if (text !== undefined) {
      try {
        const metadata = JSON.parse(text.replace(/^\uFEFF/, ""));
        if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("package.json must contain an object.");
        packageMetadata.push({ file: "package.json", ...(typeof metadata.type === "string" ? { moduleType: metadata.type } : {}), scriptsExecuted: false });
      } catch (error) { addDiagnostic("PACKAGE_METADATA_INVALID", error.message, rootPackagePath); }
    }
  }
  const parseConfig = filename => {
    const absolute = path.resolve(filename), key = canonical(absolute);
    if (configurationStack.has(key)) { addDiagnostic("PROJECT_REFERENCE_CYCLE", "Project references contain a cycle.", absolute); return parsedConfigurations.get(key); }
    if (parsedConfigurations.has(key)) return parsedConfigurations.get(key);
    if (!within(absolute, root)) { addDiagnostic("INPUT_OUTSIDE_ROOT", "A project configuration is outside projectRoot.", absolute); return undefined; }
    if (!/\.json$/i.test(absolute)) {
      readText(absolute);
      if (captures.has(key)) captures.get(key).kind = "config";
      unsupportedModes.add("dynamic-project-config");
      addDiagnostic("DYNAMIC_CONFIG_UNSUPPORTED", "Executable project configuration is not evaluated.", absolute);
      return undefined;
    }
    if (parsedConfigurations.size >= limits.maxProjects) { truncate("maxProjects", parsedConfigurations.size, absolute); return undefined; }
    const parsed = ts.getParsedCommandLineOfConfigFile(absolute, {}, parseHost);
    parsedConfigurations.set(key, parsed);
    if (!parsed) { missingInputs.add(display(absolute)); addDiagnostic("INPUT_MISSING", "The static project configuration could not be loaded.", absolute); return undefined; }
    for (const error of parsed.errors) recordNativeDiagnostic(error, display(absolute));
    for (const filename of parsed.fileNames) {
      if (!fileExists(filename)) { missingInputs.add(display(filename)); addDiagnostic("INPUT_MISSING", "A configured source file is missing or refused by the input boundary.", filename, { configFile: display(absolute) }); }
    }
    if (Array.isArray(parsed.options.plugins) && parsed.options.plugins.length) {
      unsupportedModes.add("compiler-language-service-plugins");
      addDiagnostic("PLUGINS_NOT_EXECUTED", "Configured language-service plugins are recorded but never loaded.", absolute, { category: "Warning" });
    }
    const optionView = Object.fromEntries(ts.serializeCompilerOptions(parsed.options, { configFilePath: absolute, useCaseSensitiveFileNames: caseSensitive }));
    const references = (parsed.projectReferences || []).map(ref => ts.resolveProjectReferencePath(ref));
    configurationRecords.push({ configFile: display(absolute), mode: "static-config", files: parsed.fileNames.map(display).sort(), references: references.map(display), compilerOptions: optionView,
      resolutionContext: { currentDirectory: normalize(root), ...(parsed.options.pathsBasePath ? { pathsBasePath: display(parsed.options.pathsBasePath) } : {}) },
      analysisOverrides: { noEmit: true, sourceOfProjectReferenceRedirect: !parsed.options.disableSourceOfProjectReferenceRedirect } });
    configurationStack.add(key);
    for (const reference of references) parseConfig(reference);
    configurationStack.delete(key);
    return parsed;
  };

  let mainConfiguration, primaryConfigKey;
  if (request.configFile !== undefined) mainConfiguration = path.resolve(root, request.configFile);
  else if (fileExists(path.join(root, "tsconfig.json"))) mainConfiguration = path.join(root, "tsconfig.json");
  else if (fileExists(path.join(root, "jsconfig.json"))) mainConfiguration = path.join(root, "jsconfig.json");
  if (mainConfiguration) { primaryConfigKey = canonical(mainConfiguration); parseConfig(mainConfiguration); }
  else {
    const dynamicConfig = ["tsconfig.js", "tsconfig.cjs", "tsconfig.mjs", "jsconfig.js"].map(name => path.join(root, name)).find(fileExists);
    if (dynamicConfig) parseConfig(dynamicConfig);
    else {
      const inferredPath = path.join(root, "<inferred-project>");
      primaryConfigKey = canonical(inferredPath);
      const parsed = ts.parseJsonConfigFileContent({ compilerOptions: { allowJs: true, checkJs: true, noEmit: true, target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" },
        include: ["**/*"], exclude: ["node_modules", ".git"] }, parseHost, root);
      parsedConfigurations.set(canonical(inferredPath), parsed);
      for (const error of parsed.errors) recordNativeDiagnostic(error, "<inferred-project>");
      configurationRecords.push({ configFile: "<inferred-project>", mode: "inferred-exploration", files: parsed.fileNames.map(display).sort(), references: [],
        compilerOptions: Object.fromEntries(ts.serializeCompilerOptions(parsed.options, { configFilePath: path.join(root, "tsconfig.json"), useCaseSensitiveFileNames: caseSensitive })), analysisOverrides: { noEmit: true } });
      unsupportedModes.add("project-configuration-not-provided");
      addDiagnostic("CONFIG_INFERRED", "No tsconfig/jsconfig was provided. Explicit exploration defaults were used; project configuration is incomplete.", root, { category: "Warning" });
    }
  }

  const acceptedEntries = [...additionalEntries.values()].filter(entry => entry.valid);
  if (acceptedEntries.length) {
    const primary = primaryConfigKey && parsedConfigurations.get(primaryConfigKey);
    const configuration = configurationRecords.find(record => canonical(path.resolve(root, record.configFile)) === primaryConfigKey);
    if (!primary || !configuration) {
      for (const entry of acceptedEntries) {
        entry.observation.status = "not-analyzed-no-static-config";
        addDiagnostic("ADDITIONAL_ENTRY_CONFIGURATION_UNAVAILABLE", "No primary static or disclosed inferred configuration is available for this entry.", entry.absolute);
      }
    } else {
      primary.fileNames = [...new Map([...primary.fileNames, ...acceptedEntries.map(entry => entry.absolute)].map(filename => [canonical(filename), filename])).values()];
      primary.options = { ...primary.options, allowJs: true, allowNonTsExtensions: true };
      configuration.files = primary.fileNames.map(display).sort();
      configuration.additionalEntryFiles = acceptedEntries.map(entry => ({ path: display(entry.absolute), language: "javascript", sourceKind: "JS" }));
      configuration.analysisOverrides = { ...configuration.analysisOverrides, allowJs: true, allowNonTsExtensions: true };
      for (const entry of acceptedEntries) entry.observation.configFile = configuration.configFile;
    }
  }

  const declarations = [], imports = [], calls = [];
  const declarationKeys = new Set();
  const qualifiedName = node => {
    const names = [];
    for (let cursor = node; cursor && !ts.isSourceFile(cursor); cursor = cursor.parent) {
      if (cursor.name && (ts.isDeclaration(cursor) || ts.isFunctionLike(cursor))) names.unshift(cursor.name.getText(cursor.getSourceFile()));
      else if (ts.isFunctionLike(cursor) && cursor !== node && !ts.isVariableDeclaration(cursor.parent)) names.unshift(`<${ts.SyntaxKind[cursor.kind]}@${cursor.getStart()}>`);
    }
    return names.join(".") || `<${ts.SyntaxKind[node.kind]}@${node.getStart()}>`;
  };
  const recordDeclaration = (node, configFile) => {
    const file = display(node.getSourceFile().fileName), span = spanOf(node);
    const record = { file, name: node.name?.getText(node.getSourceFile()) || `<${ts.SyntaxKind[node.kind]}>`, qualifiedName: qualifiedName(node), kind: ts.SyntaxKind[node.kind], span, configFile };
    const key = JSON.stringify([configFile, file, span.startByte, span.endByte, record.kind]);
    if (!declarationKeys.has(key)) { declarationKeys.add(key); declarations.push(record); }
    return { file, qualifiedName: record.qualifiedName, span };
  };

  for (const [configKey, parsed] of parsedConfigurations) {
    if (!parsed || !parsed.fileNames.length) continue;
    const configFile = configurationRecords.find(record => canonical(path.resolve(root, record.configFile)) === configKey)?.configFile || display(configKey);
    const host = ts.createCompilerHost({ ...parsed.options, noEmit: true }, true);
    Object.assign(host, { readFile: readText, fileExists, directoryExists, readDirectory, realpath: safeRealpath,
      getDirectories: dir => getFileSystemEntries(dir).directories, getCurrentDirectory: () => root,
      useCaseSensitiveFileNames: () => caseSensitive, getCanonicalFileName: file => caseSensitive ? file : file.toLowerCase(),
      getDefaultLibFileName: options => path.join(libRoot, ts.getDefaultLibFileName(options)),
      getParsedCommandLine: parseConfig, useSourceOfProjectReferenceRedirect: () => true,
      getEnvironmentVariable: () => "", trace: () => {}, writeFile: () => { throw new Error("Compiler emit is forbidden in this experiment."); },
      getSourceFile: (filename, languageVersion) => {
        const registration = additionalEntries.get(canonical(filename));
        if (registration && !registration.valid) return undefined;
        const text = readText(filename);
        return text === undefined ? undefined : ts.createSourceFile(filename, text, languageVersion, true, registration ? ts.ScriptKind.JS : undefined);
      } });
    let program, checker, nativeDiagnostics;
    try {
      program = ts.createProgram({ rootNames: parsed.fileNames, options: { ...parsed.options, noEmit: true }, host, projectReferences: parsed.projectReferences });
      if (configKey === primaryConfigKey) for (const entry of acceptedEntries) {
        const source = program.getSourceFile(entry.absolute);
        entry.observation.programIncluded = Boolean(source && source.scriptKind === ts.ScriptKind.JS);
        entry.observation.status = entry.observation.programIncluded ? "included-in-program" : "not-in-program";
        if (entry.observation.programIncluded) entry.observation.nativeScriptKind = "JS";
        else addDiagnostic("ADDITIONAL_ENTRY_NOT_IN_PROGRAM", "The registered source did not enter the compiler program with ScriptKind.JS.", entry.absolute, { configFile });
      }
      checker = program.getTypeChecker();
      nativeDiagnostics = ts.getPreEmitDiagnostics(program);
      for (const diagnostic of nativeDiagnostics) recordNativeDiagnostic(diagnostic, configFile);
    } catch (error) { addDiagnostic("COMPILER_ANALYSIS_FAILED", error.message, configKey, { configFile }); continue; }
    const recordImport = (sf, literal, kind) => {
      let resolved;
      try { resolved = program.getResolvedModuleFromModuleSpecifier(literal, sf)?.resolvedModule; } catch { /* A dynamic expression has no registered module resolution. */ }
      const resolvedSource = resolved?.resolvedFileName && program.getSourceFile(resolved.resolvedFileName);
      const moduleDeclarations = checker.getSymbolAtLocation(literal)?.declarations || [];
      const declarationFiles = [...new Set(moduleDeclarations.map(declaration => declaration.getSourceFile().fileName))];
      const candidateFile = resolvedSource?.fileName || resolved?.resolvedFileName || (declarationFiles.length === 1 ? declarationFiles[0] : null);
      const capture = candidateFile && captures.get(canonical(candidateFile));
      const targetFile = capture?.text !== undefined && permittedPath(capture.absolute) ? capture.absolute : null;
      imports.push({ file: display(sf.fileName), moduleSpecifier: literal.text, resolution: targetFile ? "resolved" : "unresolved", ...(targetFile ? { targetFile: display(targetFile) } : {}), span: spanOf(literal), configFile, importKind: kind });
      if (!targetFile) {
        missingInputs.add(`${display(sf.fileName)}:${literal.text}`);
        addDiagnostic("MODULE_RESOLUTION_FAILED", `No permitted static input resolves module ${JSON.stringify(literal.text)}.`, sf.fileName, { configFile });
      }
    };
    const ownRoots = new Set(parsed.fileNames.map(canonical));
    const referenceRoots = new Set((parsed.projectReferences || []).flatMap(ref => parseConfig(ts.resolveProjectReferencePath(ref))?.fileNames || []).map(canonical));
    for (const sf of program.getSourceFiles()) {
      if (!within(path.resolve(sf.fileName), root) || sf.isDeclarationFile || /(?:^|[\\/])node_modules(?:[\\/]|$)/.test(sf.fileName)) continue;
      if (referenceRoots.has(canonical(sf.fileName)) && !ownRoots.has(canonical(sf.fileName))) continue;
      const visit = node => {
        if (visitedNodes >= limits.maxNodes) { truncate("maxNodes", visitedNodes, sf.fileName); return true; }
        visitedNodes++;
        try {
          if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)
            || ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) recordDeclaration(node, configFile);
          if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) recordImport(sf, node.moduleSpecifier, ts.isExportDeclaration(node) ? "re-export" : "import");
          if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && ts.isStringLiteralLike(node.moduleReference.expression)) recordImport(sf, node.moduleReference.expression, "import-equals");
          if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
            const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
            if (dynamicImport && node.arguments?.length === 1 && ts.isStringLiteralLike(node.arguments[0])) recordImport(sf, node.arguments[0], "dynamic-import-literal");
            if (dynamicImport && !ts.isStringLiteralLike(node.arguments?.[0] || node)) { unsupportedModes.add("dynamic-module-expression"); addDiagnostic("DYNAMIC_IMPORT_UNRESOLVED", "The module expression is not a static string.", sf.fileName, { configFile }); }
            const expressionType = checker.getTypeAtLocation(node.expression);
            const signatureKind = ts.isNewExpression(node) ? ts.SignatureKind.Construct : ts.SignatureKind.Call;
            const signatures = (expressionType.isUnion() ? expressionType.types : [expressionType]).flatMap(type => checker.getSignaturesOfType(type, signatureKind));
            const signatureDeclarations = new Set(signatures.filter(signature => signature.declaration).map(signature => `${canonical(signature.declaration.getSourceFile().fileName)}:${signature.declaration.getStart()}:${signature.declaration.getEnd()}`));
            const signature = checker.getResolvedSignature(node);
            let targetNode = signature?.declaration;
            if (targetNode && (ts.isArrowFunction(targetNode) || ts.isFunctionExpression(targetNode)) && ts.isVariableDeclaration(targetNode.parent)) targetNode = targetNode.parent;
            const affectedErrors = nativeDiagnostics.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error && diagnostic.file === sf && Number.isInteger(diagnostic.start)
              && diagnostic.start < node.getEnd() && diagnostic.start + (diagnostic.length || 0) >= node.getStart());
            const unknown = dynamicImport || Boolean(expressionType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) || affectedErrors.length > 0 || !targetNode
              || expressionType.isUnion() && signatureDeclarations.size !== 1;
            let target = null;
            if (!unknown) target = recordDeclaration(targetNode, configFile);
            const resolution = target ? "confirmed" : "unresolved";
            const reason = dynamicImport ? "module-loading-expression" : affectedErrors.length ? "compiler-error-at-call" : Boolean(expressionType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) ? "any-or-unknown-type"
              : expressionType.isUnion() && signatureDeclarations.size !== 1 ? "multiple-static-signature-candidates" : !targetNode ? "no-visible-static-signature" : null;
            calls.push({ file: display(sf.fileName), callee: node.expression.getText(sf), span: spanOf(node), bindingKind: "static-signature-reference", resolution, target,
              runtimeTargetMode: "unknown", executionReachability: "not-evaluated", configFile, callKind: ts.isNewExpression(node) ? "construct" : "call", ...(reason ? { reason } : {}) });
          }
        } catch (error) { addDiagnostic("FACT_EXTRACTION_FAILED", error.message, sf.fileName, { configFile }); }
        return ts.forEachChild(node, visit);
      };
      visit(sf);
    }
  }

  for (const capture of captures.values()) {
    try {
      if (!permittedPath(capture.absolute, true)) continue;
      const stat = fs.lstatSync(capture.absolute);
      if (!stat.isFile() || stat.size !== capture.size || stat.mtimeMs !== capture.mtimeMs || stat.ino !== capture.ino || stat.dev !== capture.dev) addDiagnostic("INPUT_CHANGED_AFTER_CAPTURE", "The filesystem input changed after capture; facts retain the captured fingerprint.", capture.absolute);
    } catch (error) { addDiagnostic("INPUT_CHANGED_AFTER_CAPTURE", error.message, capture.absolute); }
  }
  const inputManifest = [...captures.values()].map(capture => ({ path: display(capture.absolute), kind: capture.kind, sha256: digest(capture.bytes), sizeBytes: capture.bytes.length,
    ...(additionalEntries.has(canonical(capture.absolute)) ? { sourceKind: additionalEntries.get(canonical(capture.absolute)).valid ? "javascript" : "unverified", declaredLanguage: "javascript", registrationKind: "explicit-additional-entry", registrationStatus: additionalEntries.get(canonical(capture.absolute)).observation.status } : {}) })).sort((a, b) => a.path.localeCompare(b.path));
  const sortFacts = (a, b) => a.file.localeCompare(b.file) || (a.configFile || "").localeCompare(b.configFile || "") || a.span.startByte - b.span.startByte || a.span.endByte - b.span.endByte;
  const errors = diagnostics.filter(diagnostic => diagnostic.category !== "Warning" && diagnostic.category !== "Message" && diagnostic.category !== "Suggestion");
  return {
    reportVersion: "project-loading-v0.1", language: "js-ts", projectId: request.projectId, capturedAt: new Date().toISOString(),
    request: { configFile: request.configFile ?? null, effectiveLimits: limits, additionalEntryFiles: additionalEntryRecords.map(entry => ({ path: entry.path, language: entry.language })) },
    rootIdentity: { id: digest(normalize(root)), requestedRoot: normalize(requestedRoot), canonicalRoot: normalize(root), caseSensitive },
    toolchain: { name: "TypeScript Compiler API", version: ts.version, modulePath: normalize(modulePath), libRoot: normalize(libRoot), moduleSha256: digest(fs.readFileSync(modulePath)),
      registrationSha256: digest(registrationBytes), source: registration.source, nodeVersion: process.version, platform: process.platform, architecture: process.arch },
    inputManifest, inputSnapshotId: digest(JSON.stringify(inputManifest)), extractorSha256: digest(fs.readFileSync(fileURLToPath(import.meta.url))), outputPolicySha256: digest(fs.readFileSync(path.join(base, "io-policy.mjs"))),
    configurations: configurationRecords, additionalEntryFiles: additionalEntryRecords, packageMetadata, declarations: declarations.sort(sortFacts), imports: imports.sort(sortFacts), calls: calls.sort(sortFacts), diagnostics,
    completeness: { complete: errors.length === 0 && missingInputs.size === 0 && unsupportedModes.size === 0 && truncations.length === 0,
      scope: "static-project-loading-and-fact-capture", targetResolutionComplete: calls.every(call => call.resolution === "confirmed"), unresolvedCalls: calls.filter(call => call.resolution === "unresolved").length,
      missingInputs: [...missingInputs].sort(), unsupportedModes: [...unsupportedModes].sort(), truncations },
    budgetObservation: { profile: "project-loading-exploration-v0.1", limits, capturedFiles: captures.size, capturedBytes: totalBytes, visitedNodes, visitedDirectories: directoryCache.size, directoryEntries, queries: queries.size,
      enforcement: "File/configuration/enumeration limits bound input acquisition; maxNodes bounds fact traversal after compiler parsing/type checking, not total compiler CPU or memory." },
    readObservations: [...queries.values()], durationMs: performance.now() - started,
    sourceExecution: "not-performed", compilerEmit: "disabled", expectedReadByExtractor: false,
    scopeLimitations: ["Complete describes input discovery and fact capture for the declared static project-loading slice; targetResolutionComplete separately records static call binding completeness. Neither means language, framework or product acceptance.",
      "Confirmed calls reference a compiler-selected static signature; all runtime targets and reachability remain unknown.",
      "Only the project root and the explicitly registered compiler-library root may supply inputs; linked dependencies are refused.",
      "Source bytes are captured once and reused; metadata changes are diagnosed, but adversarial filesystem races and an atomic filesystem snapshot are not guaranteed.",
      "No target module, executable configuration, language-service plugin, package script, build, dependency download or compiler emit is executed.",
      "HTML/Vue template mapping, framework entry/HTTP/authorization semantics, general dataflow, public schema and real worker/storage acceptance are outside this report."],
  };
}

export function writeProjectReport(request, requestedOutput = "reports/project-loading.json") {
  const output = reportPath(requestedOutput);
  assertNoLinks(output);
  const projectRoot = path.resolve(request.projectRoot);
  if (within(output, projectRoot) || within(output, fs.realpathSync(projectRoot))) throw new Error("A report must not overwrite or be written into the analyzed project.");
  const report = analyzeProject(request);
  const destination = writeReport(output, report);
  return { report, destination };
}

function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => { const i = args.indexOf(name); if (i >= 0 && !args[i + 1]) throw new Error(`Missing value for ${name}`); return i < 0 ? fallback : args[i + 1]; };
  const projectRoot = path.resolve(option("--project-root", "."));
  const request = { projectId: option("--project-id", path.basename(projectRoot)), projectRoot, ...(option("--config") ? { configFile: option("--config") } : {}) };
  const { report, destination } = writeProjectReport(request, option("--output", "reports/project-loading.json"));
  process.stdout.write(`${JSON.stringify({ output: normalize(destination), projectId: report.projectId, files: report.inputManifest.length, calls: report.calls.length, diagnostics: report.diagnostics.length, complete: report.completeness.complete })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
