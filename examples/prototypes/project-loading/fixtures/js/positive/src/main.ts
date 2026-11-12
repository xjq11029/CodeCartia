import { formatLabel as describe } from "@inventory/core";

export function describeItem(value: string): string {
  return /* 甲😀 */ describe(value);
}
