import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  createDashboardApplication,
  dashboardCommand,
  dashboardPort
} from "../src/commands/dashboard.js";
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

it("wires fresh task preflight into the dashboard application", async () => {
  expect(createDashboardApplication).toBeDefined();
  const base = await mkdtemp(join(tmpdir(), "steward-dashboard-preflight-"));
  const workspace = join(base, "workspace");
  const skillDirectory = join(workspace, ".agents", "skills", "review");
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    "---\nname: review\ndescription: Review code changes and missing tests\n---\nReview changes.\n"
  );
  const cli: CliContext = {
    cwd: workspace,
    home: join(base, "home"),
    stateDir: join(base, "state"),
    stdout: vi.fn(),
    stderr: vi.fn()
  };
  const { app, mutationToken } = createDashboardApplication(cli);

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/preflights",
    headers: { "x-skill-steward-token": mutationToken },
    payload: { task: "Review this change for missing tests", maxSkills: 3 }
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    data: { selectedSkillIds: expect.arrayContaining([expect.any(String)]) }
  });
  await app.close();
});
