import { writeFileSync } from "node:fs";
writeFileSync(import.meta.dirname + "/EXECUTED_MODULE", "unexpected");

export function keepDeclaration(value: string): string {
  return value;
}
