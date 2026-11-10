export function Widget(props: { onSelect: () => void }): JSX.Element {
  return <button onClick={props.onSelect}>Select</button>;
}
