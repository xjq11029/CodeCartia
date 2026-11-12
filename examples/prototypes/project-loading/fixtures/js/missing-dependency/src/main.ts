import { send } from "absent-transport-client";

export function deliver(value: string) {
  return send(value);
}
