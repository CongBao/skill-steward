import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  portfolioReportSchema,
  type PortfolioReport
} from "@skill-steward/engine";
import { appendReportHistory } from "./history-store.js";

const LATEST_REPORT = "latest-report.json";
const PREVIOUS_REPORT = "previous-report.json";

export interface PortfolioDiff {
  added: string[];
  changed: string[];
  removed: string[];
}

async function readReport(path: string): Promise<PortfolioReport | undefined> {
  try {
    const source = await readFile(path, "utf8");
    return portfolioReportSchema.parse(JSON.parse(source));
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

async function atomicWrite(path: string, report: PortfolioReport): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  await rename(temporaryPath, path);
}

export function readLatestReport(
  stateDirectory: string
): Promise<PortfolioReport | undefined> {
  return readReport(join(stateDirectory, LATEST_REPORT));
}

export function readPreviousReport(
  stateDirectory: string
): Promise<PortfolioReport | undefined> {
  return readReport(join(stateDirectory, PREVIOUS_REPORT));
}

export async function writeLatestReport(
  stateDirectory: string,
  input: PortfolioReport
): Promise<void> {
  const report = portfolioReportSchema.parse(input);
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });

  const current = await readLatestReport(stateDirectory);
  if (
    current !== undefined &&
    current.portfolioFingerprint !== report.portfolioFingerprint
  ) {
    await atomicWrite(join(stateDirectory, PREVIOUS_REPORT), current);
  }

  await atomicWrite(join(stateDirectory, LATEST_REPORT), report);
  await appendReportHistory(stateDirectory, report);
}

export function diffReports(
  before: PortfolioReport,
  after: PortfolioReport
): PortfolioDiff {
  const beforeById = new Map(before.skills.map((skill) => [skill.id, skill]));
  const afterById = new Map(after.skills.map((skill) => [skill.id, skill]));

  return {
    added: after.skills
      .filter((skill) => !beforeById.has(skill.id))
      .map((skill) => skill.id)
      .sort(),
    changed: after.skills
      .filter(
        (skill) =>
          beforeById.has(skill.id) &&
          beforeById.get(skill.id)?.fingerprint !== skill.fingerprint
      )
      .map((skill) => skill.id)
      .sort(),
    removed: before.skills
      .filter((skill) => !afterById.has(skill.id))
      .map((skill) => skill.id)
      .sort()
  };
}
