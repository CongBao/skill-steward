import { catalogSourceSchema } from "@skill-steward/catalog";
import {
  createCatalogServices,
  type CatalogServices
} from "@skill-steward/dashboard-server";
import type { CliContext } from "../context.js";

function services(context: CliContext): CatalogServices {
  return createCatalogServices({
    stateDirectory: context.stateDir,
    ...(context.catalogInspect ? { inspect: context.catalogInspect } : {}),
    ...(context.now ? { now: context.now } : {})
  });
}

function writeJson(context: CliContext, value: unknown): void {
  context.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

export async function catalogListCommand(
  json: boolean,
  context: CliContext
): Promise<number> {
  try {
    const result = await services(context).list();
    if (json) {
      writeJson(context, result);
      return 0;
    }
    const states = new Map(
      result.snapshot?.sources.map((state) => [state.sourceId, state]) ?? []
    );
    const lines = ["Skill catalogs", ""];
    for (const source of result.sources) {
      const state = states.get(source.id);
      lines.push(
        `- ${source.id} — ${source.name} [${source.trust}], ` +
        `${source.enabled ? "enabled" : "disabled"}, ${state?.status ?? "not refreshed"}`
      );
      if (state?.commitSha) lines.push(`  revision ${state.commitSha.slice(0, 12)}`);
      if (state?.refreshedAt) lines.push(`  refreshed ${state.refreshedAt}`);
      if (state) lines.push(`  candidates ${state.skillCount}`);
      if (state?.errorCode) lines.push(`  error ${state.errorCode}`);
    }
    lines.push("", "Publisher classification is not a safety certification.", "");
    context.stdout(lines.join("\n"));
    return 0;
  } catch (error) {
    context.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

export interface CatalogAddOptions {
  id: string;
  name: string;
  url: string;
  ref?: string;
  subdirectory?: string;
  json: boolean;
}

export async function catalogAddCommand(
  options: CatalogAddOptions,
  context: CliContext
): Promise<number> {
  try {
    const source = catalogSourceSchema.parse({
      id: options.id,
      name: options.name,
      kind: "git",
      url: options.url,
      ...(options.ref ? { ref: options.ref } : {}),
      ...(options.subdirectory ? { subdirectory: options.subdirectory } : {}),
      enabled: false,
      trust: "user",
      preset: false
    });
    const result = await services(context).add(source);
    if (options.json) writeJson(context, result);
    else context.stdout(`Added disabled catalog source '${result.id}'.\n`);
    return 0;
  } catch (error) {
    context.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

export async function catalogEnableCommand(
  id: string,
  enabled: boolean,
  json: boolean,
  context: CliContext
): Promise<number> {
  try {
    const result = await services(context).enable(id, enabled);
    if (json) writeJson(context, result);
    else context.stdout(`${enabled ? "Enabled" : "Disabled"} catalog source '${id}'.\n`);
    return 0;
  } catch (error) {
    context.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

export async function catalogRemoveCommand(
  id: string,
  confirm: boolean,
  context: CliContext
): Promise<number> {
  try {
    if (!confirm) throw new Error("Catalog removal requires --confirm");
    await services(context).remove(id);
    context.stdout(`Removed catalog source '${id}'.\n`);
    return 0;
  } catch (error) {
    context.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

export async function catalogRefreshCommand(
  json: boolean,
  context: CliContext
): Promise<number> {
  try {
    const result = await services(context).refresh();
    if (json) writeJson(context, result);
    else {
      const lines = ["Catalog refresh"];
      for (const state of result.sources) {
        lines.push(
          `- ${state.sourceId}: ${state.status}, ${state.skillCount} candidates` +
          (state.errorCode ? ` (${state.errorCode})` : "")
        );
      }
      lines.push("");
      context.stdout(lines.join("\n"));
    }
    return 0;
  } catch (error) {
    context.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
