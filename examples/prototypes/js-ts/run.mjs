import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { extract } from "./extract.mjs";
import { reportPath, reportsRoot, writeReport } from "./io-policy.mjs";
const base = path.dirname(fileURLToPath(import.meta.url));
const sentinels = ["inputs/boundary/sentinel.executed", "inputs/boundary/plugin.executed"];
for (const sentinel of sentinels) if (fs.existsSync(path.join(base, sentinel))) throw new Error(`哨兵已存在，无法证明未执行：${sentinel}`);
for (const args of [["--case", "semantic"], ["--case", "components"], ["--case", "encoding"], ["--case", "boundary"], ["--case", "semantic", "--node-limit", "10", "--output", "reports/truncated.json"]]) {
  extract(args);
}
for (const sentinel of sentinels) if (fs.existsSync(path.join(base, sentinel))) throw new Error(`分析执行了输入：${sentinel}`);
let outputRefused = false;
try { extract(["--output", "expected/checks.json"]); }
catch (error) { outputRefused = error.message.includes("reports/"); }
reportPath("reports/boundary-policy.json");
const scratch = fs.mkdtempSync(path.join(reportsRoot, ".output-policy-"));
const original = "{\"sentinel\":\"unchanged\"}\n";
const oracleDirectory = path.join(scratch, "protected");
const oracle = path.join(oracleDirectory, "source.json");
const linkChecks = [];
const links = [];
try {
  fs.mkdirSync(oracleDirectory);
  fs.writeFileSync(oracle, original);
  for (const kind of ["file", "directory"]) {
    const link = path.join(scratch, kind === "file" ? "linked.json" : "linked-parent");
    let linkType = kind === "file" ? "file-symlink" : process.platform === "win32" ? "directory-junction" : "directory-symlink";
    let unavailable = null;
    try { fs.symlinkSync(kind === "file" ? oracle : oracleDirectory, link, kind === "file" ? "file" : process.platform === "win32" ? "junction" : "dir"); }
    catch (error) {
      if (kind !== "file" || process.platform !== "win32" || error.code !== "EPERM") throw error;
      // Windows may forbid file symlink creation. Exercise the same final-path reparse check with a real junction.
      unavailable = "file-symlink-creation-EPERM";
      linkType = "final-path-directory-junction";
      fs.symlinkSync(oracleDirectory, link, "junction");
    }
    links.push(link);
    let rejected = false;
    try { writeReport(kind === "file" ? link : path.join(link, "source.json"), { forbidden: "overwrite" }); }
    catch (error) { rejected = error.message.includes("链接"); }
    linkChecks.push({ name: `${kind === "file" ? "final-path" : "parent-directory"}-link-refused-with-target-preserved`, linkType, unavailable, passed: rejected && fs.readFileSync(oracle, "utf8") === original });
  }
} finally {
  // Remove only known test links/files; never recurse through a computed or linked directory.
  for (const link of links) if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link);
  if (fs.existsSync(oracle)) fs.unlinkSync(oracle);
  if (fs.existsSync(oracleDirectory)) fs.rmdirSync(oracleDirectory);
  fs.rmdirSync(scratch);
}
writeReport("reports/boundary-policy.json", { runnerFingerprint: crypto.createHash("sha256").update(fs.readFileSync(new URL(import.meta.url))).digest("hex"), outputPolicyFingerprint: crypto.createHash("sha256").update(fs.readFileSync(new URL("./io-policy.mjs", import.meta.url))).digest("hex"), outputRefused, linkChecks, sentinelsAbsentBeforeAndAfter: true, scope: "Extractor, runner and verifier share the same report-path policy. Real final-path and parent-directory reparse points are refused without changing the protected test target; linkChecks separately records unavailable file-symlink creation and any junction substitute. Real project/build loading and adversarial concurrent filesystem replacement are untested." });
await import("./verify.mjs");
