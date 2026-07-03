import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  findingLabelSchema,
  type FindingLabel
} from "@skill-steward/engine";

const FINDING_LABELS = "finding-labels.jsonl";

export async function appendFindingLabel(
  stateDirectory: string,
  input: FindingLabel
): Promise<void> {
  const label = findingLabelSchema.parse(input);
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await appendFile(
    join(stateDirectory, FINDING_LABELS),
    `${JSON.stringify(label)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
}
