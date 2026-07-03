import {
  evidenceDatasetSchema,
  evidenceSummarySchema,
  type EvidenceBreakdown,
  type EvidenceDataset,
  type EvidenceEvent,
  type EvidenceMetric,
  type EvidenceMetrics,
  type EvidencePreflight,
  type EvidenceSummary
} from "./domain.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

function metric(numerator: number, denominator: number): EvidenceMetric {
  return {
    numerator,
    denominator,
    value: denominator === 0 ? null : numerator / denominator
  };
}

function correctedSetCounts(preflights: EvidencePreflight[]) {
  let truePositives = 0;
  let predicted = 0;
  let corrected = 0;
  let correctedSets = 0;

  for (const preflight of preflights) {
    if (preflight.feedback?.label !== "incomplete") continue;
    // Corrected sets evaluate the Skills selected for the task. Installation
    // recommendations have their own explicit-provenance conversion metric.
    const predictedIds = new Set(preflight.useCandidateIds);
    const correctedIds = new Set(preflight.feedback.candidateIds);
    truePositives += [...predictedIds].filter((id) => correctedIds.has(id)).length;
    predicted += predictedIds.size;
    corrected += correctedIds.size;
    correctedSets += 1;
  }

  return { truePositives, predicted, corrected, correctedSets };
}

function installConversion(dataset: EvidenceDataset): EvidenceMetric {
  const deliveredPreflightIds = new Set(
    dataset.preflights
      .filter(({ delivery }) => delivery !== undefined)
      .map(({ id }) => id)
  );
  for (const event of dataset.events) {
    if (event.kind === "preflight-delivered") {
      deliveredPreflightIds.add(event.preflightId);
    }
  }
  const recommendedPairs = new Set<string>();
  for (const preflight of dataset.preflights) {
    if (!deliveredPreflightIds.has(preflight.id)) continue;
    for (const candidateId of preflight.installCandidateIds) {
      recommendedPairs.add(`${preflight.id}\0${candidateId}`);
    }
  }

  const convertedPairs = new Set(
    dataset.installations
      .map(({ preflightId, candidateId }) => `${preflightId}\0${candidateId}`)
      .filter((pair) => recommendedPairs.has(pair))
  );
  return metric(convertedPairs.size, recommendedPairs.size);
}

function metricsFor(dataset: EvidenceDataset): EvidenceMetrics {
  const labeled = dataset.preflights.filter(({ feedback }) => feedback !== undefined);
  const useful = labeled.filter(({ feedback }) => feedback?.label === "useful").length;
  const incomplete = labeled.filter(({ feedback }) => feedback?.label === "incomplete").length;
  const incorrect = labeled.filter(({ feedback }) => feedback?.label === "incorrect").length;
  const correction = correctedSetCounts(dataset.preflights);

  return {
    feedbackRate: metric(labeled.length, dataset.preflights.length),
    usefulRate: metric(useful, labeled.length),
    incompleteRate: metric(incomplete, labeled.length),
    incorrectRate: metric(incorrect, labeled.length),
    correctionPrecision: metric(correction.truePositives, correction.predicted),
    correctionRecall: metric(correction.truePositives, correction.corrected),
    correctionF1: metric(2 * correction.truePositives, correction.predicted + correction.corrected),
    installConversion: installConversion(dataset)
  };
}

function totalsFor(dataset: EvidenceDataset) {
  return {
    preflights: dataset.preflights.length,
    labeled: dataset.preflights.filter(({ feedback }) => feedback !== undefined).length,
    portfolios: new Set(dataset.preflights.map(({ portfolioFingerprint }) => portfolioFingerprint)).size,
    events: dataset.events.length
  };
}

function breakdown(key: string, dataset: EvidenceDataset): EvidenceBreakdown {
  return {
    key,
    totals: totalsFor(dataset),
    metrics: metricsFor(dataset)
  };
}

function eventPreflightId(event: EvidenceEvent): string | undefined {
  return "preflightId" in event ? event.preflightId : undefined;
}

function subsetForPreflights(
  dataset: EvidenceDataset,
  preflights: EvidencePreflight[],
  eventPredicate?: (event: EvidenceEvent) => boolean
): EvidenceDataset {
  const preflightIds = new Set(preflights.map(({ id }) => id));
  return {
    schemaVersion: 1,
    preflights,
    events: dataset.events.filter((event) => {
      const preflightId = eventPreflightId(event);
      return (preflightId !== undefined && preflightIds.has(preflightId)) || Boolean(eventPredicate?.(event));
    }),
    installations: dataset.installations.filter(({ preflightId }) => preflightIds.has(preflightId))
  };
}

function harnessBreakdowns(dataset: EvidenceDataset): EvidenceBreakdown[] {
  const keys = [...new Set(dataset.preflights.map(({ harness }) => harness ?? "unknown"))].sort();
  return keys.map((key) => {
    const preflights = dataset.preflights.filter(({ harness }) => (harness ?? "unknown") === key);
    const subset = subsetForPreflights(
      dataset,
      preflights,
      (event) => "harness" in event && event.harness === key
    );
    return breakdown(key, subset);
  });
}

function algorithmBreakdowns(dataset: EvidenceDataset): EvidenceBreakdown[] {
  const versions = [...new Set(dataset.preflights.map(({ algorithmVersion }) => algorithmVersion))]
    .sort((left, right) => left - right);
  return versions.map((version) => {
    const preflights = dataset.preflights.filter(({ algorithmVersion }) => algorithmVersion === version);
    const subset = subsetForPreflights(
      dataset,
      preflights,
      (event) => event.kind === "preflight-delivered" && event.algorithmVersion === version
    );
    return breakdown(String(version), subset);
  });
}

function rollingDataset(dataset: EvidenceDataset, now: Date, days: number): EvidenceDataset {
  const threshold = now.getTime() - days * DAY_MS;
  const inWindow = (createdAt: string) => new Date(createdAt).getTime() >= threshold
    && new Date(createdAt).getTime() <= now.getTime();
  return {
    schemaVersion: 1,
    preflights: dataset.preflights.filter(({ createdAt }) => inWindow(createdAt)),
    events: dataset.events.filter(({ createdAt }) => inWindow(createdAt)),
    installations: dataset.installations.filter(({ createdAt }) => inWindow(createdAt))
  };
}

function periodFor(dataset: EvidenceDataset): EvidenceSummary["period"] {
  const timestamps = [
    ...dataset.preflights.map(({ createdAt }) => createdAt),
    ...dataset.events.map(({ createdAt }) => createdAt),
    ...dataset.installations.map(({ createdAt }) => createdAt)
  ].sort();
  return {
    from: timestamps.at(0) ?? null,
    to: timestamps.at(-1) ?? null
  };
}

function lifecycleReasons(dataset: EvidenceDataset): EvidenceSummary["lifecycleReasons"] {
  const reasons: EvidenceSummary["lifecycleReasons"] = {};
  for (const event of dataset.events) {
    if (event.kind !== "turn-finished" && event.kind !== "session-ended") continue;
    reasons[event.reason] = (reasons[event.reason] ?? 0) + 1;
  }
  return reasons;
}

function readinessFor(dataset: EvidenceDataset): EvidenceSummary["readiness"] {
  const totals = totalsFor(dataset);
  const correctedSets = correctedSetCounts(dataset.preflights).correctedSets;
  const reasons: string[] = [];
  if (totals.labeled < 100) reasons.push("Need 100 labeled preflights");
  if (correctedSets < 30) reasons.push("Need 30 corrected candidate sets");
  if (totals.portfolios < 20) reasons.push("Need 20 portfolio fingerprints");
  return reasons.length === 0
    ? { status: "ready-for-calibration", reasons }
    : { status: "insufficient-evidence", reasons };
}

export function aggregateEvidence(input: EvidenceDataset, now = new Date()): EvidenceSummary {
  const dataset = evidenceDatasetSchema.parse(input);
  const last7Days = rollingDataset(dataset, now, 7);
  const last30Days = rollingDataset(dataset, now, 30);
  return evidenceSummarySchema.parse({
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    period: periodFor(dataset),
    totals: totalsFor(dataset),
    metrics: metricsFor(dataset),
    lifecycleReasons: lifecycleReasons(dataset),
    harnesses: harnessBreakdowns(dataset),
    algorithms: algorithmBreakdowns(dataset),
    windows: {
      last7Days: breakdown("7d", last7Days),
      last30Days: breakdown("30d", last30Days)
    },
    readiness: readinessFor(dataset)
  });
}
