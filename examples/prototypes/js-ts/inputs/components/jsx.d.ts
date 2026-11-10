declare namespace JSX {
  interface Element {}
  interface IntrinsicElements {
    button: { children?: unknown; onClick?: () => void };
    div: { children?: unknown };
  }
}
