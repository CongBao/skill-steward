import type { ReactNode } from "react";

export function StatePanel({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return (
    <section className="state-panel">
      <h2>{title}</h2><p>{description}</p>{action}
    </section>
  );
}
