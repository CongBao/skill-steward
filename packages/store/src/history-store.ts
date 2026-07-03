import {
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile
} from "node:fs/promises";
import { join } from "node:path";
import {
  portfolioReportSchema,
  type PortfolioReport
} from "@skill-steward/engine";

const HISTORY_DIRECTORY = "history";
const INDEX_FILE = "index.json";

interface HistoryIndexItem {
  portfolioFingerprint: string;
  generatedAt: string;
  fileName: string;
}

export interface AppendHistoryOptions {
  limit?: number;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function parseIndex(value: unknown): HistoryIndexItem[] {
  if (!Array.isArray(value)) throw new Error("History index must be an array");
  return value.map((item) => {
    if (
      typeof item !== "object" ||
      item === null ||
      !("portfolioFingerprint" in item) ||
      typeof item.portfolioFingerprint !== "string" ||
      !("generatedAt" in item) ||
      typeof item.generatedAt !== "string" ||
      !("fileName" in item) ||
      typeof item.fileName !== "string"
    ) {
      throw new Error("History index contains an invalid entry");
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(item.portfolioFingerprint)) {
      throw new Error("History index contains an invalid fingerprint");
    }
    if (Number.isNaN(Date.parse(item.generatedAt))) {
      throw new Error("History index contains an invalid timestamp");
    }
    if (!/^[a-f0-9]{64}\.json$/.test(item.fileName)) {
      throw new Error("History index contains an invalid file name");
    }
    return {
      portfolioFingerprint: item.portfolioFingerprint,
      generatedAt: item.generatedAt,
      fileName: item.fileName
    };
  });
}

async function readIndex(historyDirectory: string): Promise<HistoryIndexItem[]> {
  try {
    const source = await readFile(join(historyDirectory, INDEX_FILE), "utf8");
    return parseIndex(JSON.parse(source));
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  await rename(temporaryPath, path);
}

export async function appendReportHistory(
  stateDirectory: string,
  input: PortfolioReport,
  options: AppendHistoryOptions = {}
): Promise<void> {
  const report = portfolioReportSchema.parse(input);
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("History limit must be a positive integer");
  }

  const historyDirectory = join(stateDirectory, HISTORY_DIRECTORY);
  await mkdir(historyDirectory, { recursive: true, mode: 0o700 });
  const current = await readIndex(historyDirectory);
  if (
    current.some(
      ({ portfolioFingerprint }) =>
        portfolioFingerprint === report.portfolioFingerprint
    )
  ) {
    return;
  }

  const fileName = `${report.portfolioFingerprint.slice("sha256:".length)}.json`;
  await atomicWrite(join(historyDirectory, fileName), report);

  const next = [
    {
      portfolioFingerprint: report.portfolioFingerprint,
      generatedAt: report.generatedAt,
      fileName
    },
    ...current
  ];
  const retained = next.slice(0, limit);
  const pruned = next.slice(limit);
  await atomicWrite(join(historyDirectory, INDEX_FILE), retained);

  await Promise.all(
    pruned.map(async ({ fileName: staleFile }) => {
      try {
        await unlink(join(historyDirectory, staleFile));
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    })
  );
}

export async function readReportHistory(
  stateDirectory: string
): Promise<PortfolioReport[]> {
  const historyDirectory = join(stateDirectory, HISTORY_DIRECTORY);
  const index = await readIndex(historyDirectory);
  return Promise.all(
    index.map(async ({ fileName }) => {
      const source = await readFile(join(historyDirectory, fileName), "utf8");
      return portfolioReportSchema.parse(JSON.parse(source));
    })
  );
}
