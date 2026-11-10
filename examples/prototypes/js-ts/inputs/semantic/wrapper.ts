import { transport as transmit } from "@core/transport";
export function request(route: string): string {
  return transmit(route);
}
