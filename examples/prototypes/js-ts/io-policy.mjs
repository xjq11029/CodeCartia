import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const base = path.dirname(fileURLToPath(import.meta.url));
export const reportsRoot = path.join(base, "reports");
const within = (candidate, root) => candidate === root || candidate.startsWith(root + path.sep);

// Every extractor/runner/verifier report write uses this boundary, including existing files.
export function reportPath(requestedPath) {
  const destination = path.resolve(base, requestedPath);
  if (!within(destination, reportsRoot) || path.extname(destination) !== ".json") throw new Error("报告仅能写入 reports/ 下的 JSON 文件。");
  for (let cursor = destination; within(cursor, base); cursor = path.dirname(cursor)) {
    try {
      const info = fs.lstatSync(cursor);
      if (info.isSymbolicLink()) throw new Error("报告路径不能经过链接或重解析点。");
      if (info.isFile() && info.nlink > 1) throw new Error("报告不能写入具有多个硬链接的文件。");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return destination;
}

export function writeReport(requestedPath, value) {
  const destination = reportPath(requestedPath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  // Recheck after directory creation, immediately before the write.
  reportPath(destination);
  fs.writeFileSync(destination, JSON.stringify(value, null, 2) + "\n");
  return destination;
}
