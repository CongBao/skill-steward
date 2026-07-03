import { expect, it, vi } from "vitest";
import { dashboardCommand, dashboardPort } from "../src/commands/dashboard.js";
import type { CliContext } from "../src/context.js";

function context(): CliContext & { output: string[] } {
  const output: string[] = [];
  return {
    cwd: "/repo",
    home: "/home/alice",
    stateDir: "/home/alice/.skill-steward",
    stdout: (value) => output.push(value),
    stderr: vi.fn(),
    output
  };
}

it("launches a loopback dashboard and optionally opens the URL", async () => {
  const cli = context();
  const launch = vi.fn(async () => ({ url: "http://127.0.0.1:4873" }));
  const open = vi.fn(async () => undefined);

  expect(
    await dashboardCommand({ port: 4873, open: true }, cli, { launch, open })
  ).toBe(0);
  expect(launch).toHaveBeenCalledWith({ port: 4873, context: cli });
  expect(open).toHaveBeenCalledWith("http://127.0.0.1:4873");
  expect(cli.output.join("")).toContain("http://127.0.0.1:4873");
});

it("validates dashboard ports", () => {
  expect(dashboardPort("0")).toBe(0);
  expect(dashboardPort("4762")).toBe(4762);
  expect(() => dashboardPort("70000")).toThrow("port");
  expect(() => dashboardPort("not-a-number")).toThrow("port");
});
