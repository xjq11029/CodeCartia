import { useState } from "react";
import { Card } from "./Card";
export function Page() {
  const [selected, setSelected] = useState(false);
  return selected ? <div>Selected</div> : <Card onSelect={() => setSelected(true)} />;
}
