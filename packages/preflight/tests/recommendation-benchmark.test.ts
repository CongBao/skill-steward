import { readFile } from "node:fs/promises";
import type { PortfolioReportV2, SkillRecordV2 } from "@skill-steward/engine";
import { describe, expect, it } from "vitest";
import { analyzePreflight } from "../src/analyze.js";

interface BenchmarkCandidate {
  id: string;
  name: string;
  description: string;
  contextTokens: number;
}

interface BenchmarkCase {
  id: string;
  pairId: string;
  language: "en" | "zh";
  task: string;
  expected: string[];
  negativeControl?: boolean;
}

interface Benchmark {
  schemaVersion: 1;
  candidates: BenchmarkCandidate[];
  cases: BenchmarkCase[];
}

const hash = (character: string) => `sha256:${character.repeat(64)}`;

function record(candidate: BenchmarkCandidate): SkillRecordV2 {
  const sourceId = `codex:benchmark:${candidate.id}`;
  return {
    id: candidate.id,
    name: candidate.name,
    description: candidate.description,
    path: `/benchmark/${candidate.id}`,
    root: candidate.id,
    scope: "global",
    visibleTo: ["codex"],
    fingerprint: hash(candidate.id.length % 2 === 0 ? "b" : "c"),
    files: [],
    estimatedTokens: candidate.contextTokens,
    ownership: "direct",
    sourceIds: [sourceId],
    exposures: [{
      harness: "codex",
      effectiveName: candidate.name,
      state: "effective",
      sourceId,
      reason: "BENCHMARK_EFFECTIVE"
    }]
  };
}

function report(skills: SkillRecordV2[]): PortfolioReportV2 {
  return {
    schemaVersion: 2,
    generatedAt: "2026-07-06T00:00:00.000Z",
    portfolioFingerprint: hash("a"),
    workspace: { path: "/benchmark", identity: hash("d") },
    skills,
    findings: [],
    inventory: {
      sources: skills.map((skill) => ({
        id: skill.sourceIds[0]!,
        harness: "codex" as const,
        scope: "global" as const,
        kind: "direct-root" as const,
        path: `/benchmark/${skill.id}`,
        status: "scanned" as const,
        skillCount: 1,
        effectiveSkillCount: 1
      })),
      harnesses: [{
        harness: "codex",
        status: "verified",
        sourceIds: skills.map((skill) => skill.sourceIds[0]!),
        skillCount: skills.length,
        effectiveSkillCount: skills.length
      }]
    }
  };
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

describe("recommendation quality benchmark v9", () => {
  it("meets the published bilingual precision, recall, exact-set, negative, context, and determinism gates", async () => {
    const benchmark = JSON.parse(await readFile(
      new URL("../benchmarks/recommendation-v9.json", import.meta.url),
      "utf8"
    )) as Benchmark;
    expect(benchmark.schemaVersion).toBe(1);
    expect(benchmark.cases.length).toBeGreaterThanOrEqual(24);
    expect(new Set(benchmark.cases.map(({ pairId }) => pairId)).size)
      .toBeGreaterThanOrEqual(10);
    expect(benchmark.cases.filter(({ negativeControl }) => negativeControl).length)
      .toBeGreaterThanOrEqual(4);

    const skills = benchmark.candidates.map(record);
    const tokenById = new Map(benchmark.candidates.map(({ id, contextTokens }) => [
      id,
      contextTokens
    ]));
    const predictions = new Map<string, string[]>();
    let truePositive = 0;
    let falsePositive = 0;
    let falseNegative = 0;
    let exact = 0;
    let negativeFalsePositives = 0;

    for (const [index, scenario] of benchmark.cases.entries()) {
      const base = {
        id: `benchmark-${index}`,
        now: new Date("2026-07-06T01:00:00.000Z"),
        task: scenario.task,
        report: report(skills),
        catalogSkills: [],
        catalogSources: [],
        harness: "codex" as const,
        maxSkills: 3
      };
      const first = analyzePreflight(base);
      const second = analyzePreflight({ ...base, report: report([...skills].reverse()) });
      const predicted = sorted(first.useCandidateIds);
      const expected = sorted(scenario.expected);
      predictions.set(scenario.id, predicted);
      expect(sorted(second.useCandidateIds), `${scenario.id} determinism`).toEqual(predicted);
      expect(first.selectedContextTokens, `${scenario.id} context accounting`).toBe(
        predicted.reduce((total, id) => total + (tokenById.get(id) ?? 0), 0)
      );

      const predictedSet = new Set(predicted);
      const expectedSet = new Set(expected);
      truePositive += predicted.filter((id) => expectedSet.has(id)).length;
      falsePositive += predicted.filter((id) => !expectedSet.has(id)).length;
      falseNegative += expected.filter((id) => !predictedSet.has(id)).length;
      if (JSON.stringify(predicted) === JSON.stringify(expected)) exact += 1;
      if (scenario.negativeControl) negativeFalsePositives += predicted.length;
    }

    const precision = truePositive / (truePositive + falsePositive || 1);
    const recall = truePositive / (truePositive + falseNegative || 1);
    const f1 = 2 * precision * recall / (precision + recall || 1);
    const exactSetAccuracy = exact / benchmark.cases.length;
    const pairs = new Map<string, BenchmarkCase[]>();
    for (const scenario of benchmark.cases) {
      const values = pairs.get(scenario.pairId) ?? [];
      values.push(scenario);
      pairs.set(scenario.pairId, values);
    }
    const bilingualPairs = [...pairs.values()].filter((values) =>
      values.some(({ language }) => language === "en") &&
      values.some(({ language }) => language === "zh")
    );
    const bilingualMatches = bilingualPairs.filter((values) => {
      const english = values.find(({ language }) => language === "en")!;
      const chinese = values.find(({ language }) => language === "zh")!;
      return JSON.stringify(predictions.get(english.id)) ===
        JSON.stringify(predictions.get(chinese.id));
    }).length;
    const bilingualParity = bilingualMatches / bilingualPairs.length;

    const metrics = {
      cases: benchmark.cases.length,
      precision,
      recall,
      f1,
      exactSetAccuracy,
      bilingualParity,
      negativeFalsePositives
    };
    console.info(`[preflight-quality-v9] ${JSON.stringify(metrics)}`);
    expect(metrics, JSON.stringify({
      metrics,
      predictions: Object.fromEntries(predictions)
    }, null, 2)).toMatchObject({
      negativeFalsePositives: 0
    });
    expect(precision, JSON.stringify(metrics)).toBeGreaterThanOrEqual(0.85);
    expect(recall, JSON.stringify(metrics)).toBeGreaterThanOrEqual(0.85);
    expect(exactSetAccuracy, JSON.stringify(metrics)).toBeGreaterThanOrEqual(0.75);
    expect(bilingualParity, JSON.stringify(metrics)).toBeGreaterThanOrEqual(0.9);
  });
});
