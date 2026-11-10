export function convert(value: string): string;
export function convert(value: number): number;
export function convert(value: string | number): string | number {
  return value;
}

export const left = (value: string): string => value;
export const right = (value: string): number => value.length;
export declare const unknownFlag: boolean;
export const selected = unknownFlag ? left : right;
