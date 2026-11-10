import { request as invoke } from "@core/wrapper";
import { convert, selected } from "./overload";

export function sourceA(): string {
  return invoke("/alpha");
}
export function sourceB(): string {
  return invoke("/beta");
}

export function outerA(): string {
  function same(value: string): string { return value; }
  return same("scope-a");
}
export function outerB(): string {
  function same(value: string): string { return value; }
  return same("scope-b");
}

export const convertedText = convert("ok");
export const convertedNumber = convert(7);
export const conditionalResult = selected("candidate");
export const invalidOverload = convert(true);

declare const dynamic: any;
export const unknownResult = dynamic("opaque");
