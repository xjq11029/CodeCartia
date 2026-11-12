import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export const base = path.dirname(fileURLToPath(import.meta.url));
export const reportsRoot = path.join(base, "reports");
export const normalize = filename => filename.replaceAll("\\", "/");
export const hash = bytes => `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
export function inside(filename, root) {
  const relative = path.relative(root, filename);
  return relative === "" || !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}
export function noLinks(filename) {
  for (let cursor = path.resolve(filename); ; cursor = path.dirname(cursor)) {
    try { if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`LINK_REFUSED: ${cursor}`); }
    catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error; }
    if (cursor === path.dirname(cursor)) break;
  }
}
export function readBytes(filename) {
  noLinks(filename);
  const before = fs.statSync(filename);
  if (!before.isFile() || before.size > 64 * 1024 * 1024) throw new Error("INPUT_TYPE_OR_SIZE_REFUSED");
  const bytes = fs.readFileSync(filename);
  noLinks(filename);
  const after = fs.statSync(filename);
  if (before.ino !== after.ino || before.dev !== after.dev || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) throw new Error("INPUT_CHANGED_DURING_READ");
  return bytes;
}
export function writeJSON(filename, value, inputRoots = []) {
  const output = path.resolve(base, filename);
  const check = () => {
    if (!inside(output, reportsRoot) || output === reportsRoot || path.extname(output) !== ".json") throw new Error("OUTPUT_OUTSIDE_REPORTS");
    noLinks(output);
    if (inputRoots.some(root => inside(output, path.resolve(root)))) throw new Error("OUTPUT_OVERLAPS_INPUT");
    if (fs.existsSync(output) && fs.statSync(output).nlink > 1) throw new Error("OUTPUT_HARD_LINK_REFUSED");
  };
  check();
  fs.mkdirSync(path.dirname(output), { recursive: true });
  check();
  const temporary = path.join(path.dirname(output), `.mapping-${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
    check();
    fs.renameSync(temporary, output);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  return output;
}
