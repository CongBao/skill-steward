import type { FindingLabel } from "@skill-steward/engine";
import {
  appendFindingLabel,
  readLatestReport
} from "@skill-steward/store";
import type { CliContext } from "../context.js";

export async function labelCommand(
  findingId: string,
  label: FindingLabel["label"],
  comment: string | undefined,
  context: CliContext
): Promise<number> {
  const report = await readLatestReport(context.stateDir);
  if (!report?.findings.some((finding) => finding.id === findingId)) {
    context.stderr(
      `Finding '${findingId}' does not exist in the latest report.\n`
    );
    return 1;
  }

  await appendFindingLabel(context.stateDir, {
    findingId,
    label,
    createdAt: new Date().toISOString(),
    ...(comment ? { comment } : {})
  });
  context.stdout(`Recorded '${label}' for ${findingId}.\n`);
  return 0;
}
