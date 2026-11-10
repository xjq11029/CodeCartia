"use client";
import { store } from "./actions";
export function ActionButton() {
  return <button onClick={() => store("value")}>Store</button>;
}
