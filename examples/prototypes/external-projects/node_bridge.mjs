import fs from "node:fs";
import path from "node:path";
import Module from "node:module";
import { fileURLToPath } from "node:url";
import { analyzeProject } from "../js-ts/project-extract.mjs";

const request = JSON.parse(process.argv[2]);
const root = path.resolve(request.projectRoot);
const excludedDirectories = new Set([".git", ".hg", ".svn", "models", "dll", "public", "logs", "records", "recordings", "__pycache__", ".venv", "venv", ".tox"]);
const runtimeSuffixes = new Set([".dll", ".so", ".dylib", ".onnx", ".pt", ".pth", ".h5", ".hdf5", ".tflite", ".bin", ".db", ".sqlite", ".sqlite3", ".npy", ".npz", ".pkl", ".pickle", ".mp4", ".avi", ".m3u8", ".jpg", ".jpeg", ".png", ".wav", ".log"]);
const staticSuffixes = new Set([".js", ".jsx", ".cjs", ".mjs", ".ts", ".tsx", ".cts", ".mts", ".py", ".json", ".toml", ".cfg"]);
const reads = new Set(), excluded = new Set(), rejectedReads = [], rejectedWrites = [], rejectedExecutions = [];
const normalize = value => value.replaceAll("\\", "/");
const relativePath = value => {
  if (typeof value !== "string" && !Buffer.isBuffer(value) && !(value instanceof URL)) return null;
  const absolute = path.resolve(value instanceof URL ? fileURLToPath(value) : String(value));
  const relative = path.relative(root, absolute);
  return relative === "" || !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative) ? normalize(relative) : null;
};
const blocked = relative => relative.split("/").some(part => excludedDirectories.has(part.toLowerCase())) || path.basename(relative).toLowerCase().startsWith(".env") || runtimeSuffixes.has(path.extname(relative).toLowerCase());
const readable = relative => !blocked(relative) && (staticSuffixes.has(path.extname(relative).toLowerCase()) || ["readme.md", "agents.md", "requirements.txt"].includes(path.basename(relative).toLowerCase()) || relative === "bin/www");
const checkRead = filename => {
  const relative = relativePath(filename);
  if (relative === null) return;
  if (!readable(relative)) {
    rejectedReads.push(relative);
    throw Object.assign(new Error("Runtime data is outside this observation"), { code: "EXTERNAL_RUNTIME_INPUT_REFUSED" });
  }
  reads.add(relative);
};
const checkWrite = filename => {
  const relative = relativePath(filename);
  if (relative !== null) {
    rejectedWrites.push(relative);
    throw Object.assign(new Error("External project writes are forbidden"), { code: "EXTERNAL_WRITE_REFUSED" });
  }
};
const originalLoad = Module._load;
const originalResolve = Module._resolveFilename;
Module._load = function (specifier, parent, isMain) {
  const resolved = originalResolve.call(Module, specifier, parent, isMain);
  const relative = relativePath(resolved);
  if (relative !== null) {
    rejectedExecutions.push(relative);
    throw Object.assign(new Error("Target CommonJS modules must not be executed"), { code: "EXTERNAL_EXECUTION_REFUSED" });
  }
  return originalLoad.call(this, specifier, parent, isMain);
};
const original = Object.fromEntries(["openSync", "readFileSync", "readdirSync", "writeFileSync", "appendFileSync", "mkdirSync", "unlinkSync", "rmSync", "rmdirSync", "renameSync", "copyFileSync", "linkSync", "symlinkSync"].map(name => [name, fs[name].bind(fs)]));
fs.openSync = (filename, flags, ...args) => {
  const writing = typeof flags === "number" ? Boolean(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) : /[wax+]/.test(flags);
  if (writing) checkWrite(filename); else checkRead(filename);
  return original.openSync(filename, flags, ...args);
};
fs.readFileSync = (filename, ...args) => { checkRead(filename); return original.readFileSync(filename, ...args); };
fs.readdirSync = (dirname, ...args) => {
  const relative = relativePath(dirname);
  if (relative !== null && blocked(relative)) {
    rejectedReads.push(relative);
    throw Object.assign(new Error("Runtime directory is outside this observation"), { code: "EXTERNAL_RUNTIME_INPUT_REFUSED" });
  }
  const entries = original.readdirSync(dirname, ...args);
  if (relative === null) return entries;
  return entries.filter(entry => {
    const name = typeof entry === "string" || Buffer.isBuffer(entry) ? String(entry) : entry.name;
    const child = normalize(path.join(relative, name));
    if (!blocked(child)) return true;
    excluded.add(child);
    return false;
  });
};
for (const name of ["writeFileSync", "appendFileSync", "mkdirSync", "unlinkSync", "rmSync", "rmdirSync"]) fs[name] = (filename, ...args) => { checkWrite(filename); return original[name](filename, ...args); };
for (const name of ["renameSync", "copyFileSync", "linkSync", "symlinkSync"]) fs[name] = (source, destination, ...args) => { checkWrite(source); checkWrite(destination); return original[name](source, destination, ...args); };

const report = analyzeProject(request);
process.stdout.write(JSON.stringify({ raw: report, accessAudit: { policyVersion: "external-static-inputs-v0.1", projectRoot: normalize(root), staticReadAttempts: [...reads].sort(), excludedDiscoveryPaths: [...excluded].sort(), rejectedReadAttempts: rejectedReads, rejectedWriteAttempts: rejectedWrites, rejectedExecutionAttempts: rejectedExecutions, executionAuditScope: "CommonJS target-root Module._load denial; target source is otherwise parsed by the trusted Compiler API." } }));
