import { writeFileSync } from "node:fs";
writeFileSync(import.meta.dirname + "/EXECUTED_CONFIG", "unexpected");
export default { include: ["src/**/*.ts"] };
