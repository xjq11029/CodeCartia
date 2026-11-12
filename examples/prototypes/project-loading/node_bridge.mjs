import fs from "node:fs";
import { analyzeProject } from "../js-ts/project-extract.mjs";

// Only this repository's trusted extractor is imported. The request is data.
try {
  const request = JSON.parse(fs.readFileSync(0, "utf8"));
  const report = await analyzeProject(request);
  process.stdout.write(JSON.stringify(report));
} catch (error) {
  process.stderr.write(`${error.name}: ${error.message}\n`);
  process.exitCode = 1;
}
