export function Card(props: { onSelect: () => void }) {
  return <button onClick={props.onSelect}>Select</button>;
}
