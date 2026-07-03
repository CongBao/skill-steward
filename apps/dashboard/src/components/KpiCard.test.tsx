import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { KpiCard } from "./KpiCard.js";

it("renders a metric with an accessible textual summary", () => {
  render(
    <KpiCard
      label="Health score"
      value="92"
      detail="Healthy, up 4"
      status="positive"
      hero
    />
  );
  expect(screen.getByRole("article", { name: "Health score: 92. Healthy, up 4" })).toBeVisible();
});
