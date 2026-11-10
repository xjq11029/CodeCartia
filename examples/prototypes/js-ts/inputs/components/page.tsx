import { Widget as View } from "./Widget";
export function handle(): void {}
export function Page(): JSX.Element {
  return <View onSelect={handle} />;
}
