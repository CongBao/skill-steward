import { randomUUID } from "node:crypto";
import {
  evidenceEventSchema,
  pseudonymousKeySchema,
  type EvidenceEvent,
  type PseudonymousKey
} from "@skill-steward/evidence";
import { z } from "zod";
import {
  integrationHarnessSchema,
  type IntegrationHarness,
  type PromptHookInput
} from "./domain.js";

const correlationIdSchema = z.string().min(1).max(1_024);

const codexStopInputSchema = z.object({
  hook_event_name: z.literal("Stop"),
  session_id: correlationIdSchema.optional(),
  turn_id: correlationIdSchema.optional(),
  reason: z.string().max(128).optional()
}).passthrough();

const claudeStopInputSchema = z.object({
  hook_event_name: z.literal("Stop"),
  session_id: correlationIdSchema.optional(),
  stop_hook_active: z.boolean()
}).passthrough();

const claudeSessionEndInputSchema = z.object({
  hook_event_name: z.literal("SessionEnd"),
  session_id: correlationIdSchema.optional(),
  reason: z.enum([
    "clear",
    "resume",
    "logout",
    "prompt_input_exit",
    "bypass_permissions_disabled",
    "other"
  ])
}).passthrough();

const claudeLifecycleInputSchema = z.discriminatedUnion("hook_event_name", [
  claudeStopInputSchema,
  claudeSessionEndInputSchema
]);

export interface LifecyclePrivacy {
  key(namespace: "session" | "turn", raw: string): string;
}

interface EventFactoryOptions {
  privacy?: LifecyclePrivacy;
  now?: () => Date;
  id?: () => string;
}

function correlationKey(
  privacy: LifecyclePrivacy | undefined,
  namespace: "session" | "turn",
  raw: string | undefined
): PseudonymousKey | undefined {
  return privacy && raw
    ? pseudonymousKeySchema.parse(privacy.key(namespace, raw))
    : undefined;
}

function turnReason(reason: string | undefined): "complete" | "error" | "abort" | "timeout" | "other" {
  if (reason === "error") return "error";
  if (reason === "abort" || reason === "interrupted") return "abort";
  if (reason === "timeout") return "timeout";
  if (reason !== undefined && reason !== "complete" && reason !== "end_turn") return "other";
  return "complete";
}

export interface PromptDeliveryInput extends EventFactoryOptions {
  harness: IntegrationHarness;
  payload: PromptHookInput;
  preflightId: string;
  algorithmVersion: number;
}

export function normalizePromptDelivery(input: PromptDeliveryInput): EvidenceEvent {
  const harness = integrationHarnessSchema.parse(input.harness);
  const sessionKey = correlationKey(input.privacy, "session", input.payload.session_id);
  const turnKey = correlationKey(input.privacy, "turn", input.payload.turn_id);
  return evidenceEventSchema.parse({
    schemaVersion: 1,
    id: input.id?.() ?? randomUUID(),
    createdAt: (input.now?.() ?? new Date()).toISOString(),
    kind: "preflight-delivered",
    harness,
    preflightId: input.preflightId,
    algorithmVersion: input.algorithmVersion,
    ...(sessionKey ? { sessionKey } : {}),
    ...(turnKey ? { turnKey } : {})
  });
}

export interface NormalizeLifecycleInput extends EventFactoryOptions {
  harness: IntegrationHarness;
  stdin: string;
  preflightId?: string;
  events?: EvidenceEvent[];
}

function latestOpenPreflightId(
  events: EvidenceEvent[],
  harness: IntegrationHarness,
  sessionKey: PseudonymousKey | undefined
): string | undefined {
  if (!sessionKey) return undefined;
  const deliveries = events
    .filter((event): event is Extract<EvidenceEvent, { kind: "preflight-delivered" }> =>
      event.kind === "preflight-delivered"
      && event.harness === harness
      && event.sessionKey === sessionKey
    )
    .sort((left, right) =>
      Date.parse(right.createdAt) - Date.parse(left.createdAt)
      || right.id.localeCompare(left.id)
    );
  return deliveries.find((delivery) => !events.some((event) =>
    event.kind === "turn-finished"
    && event.harness === harness
    && event.preflightId === delivery.preflightId
    && (!event.sessionKey || event.sessionKey === sessionKey)
    && Date.parse(event.createdAt) >= Date.parse(delivery.createdAt)
  ))?.preflightId;
}

function sessionReason(
  reason: z.infer<typeof claudeSessionEndInputSchema>["reason"]
): "user-exit" | "other" {
  return reason === "clear"
    || reason === "resume"
    || reason === "logout"
    || reason === "prompt_input_exit"
    ? "user-exit"
    : "other";
}

export function normalizeLifecycleInput(input: NormalizeLifecycleInput): EvidenceEvent {
  const harness = integrationHarnessSchema.parse(input.harness);
  const raw: unknown = JSON.parse(input.stdin);
  if (harness === "codex") {
    const payload = codexStopInputSchema.parse(raw);
    const sessionKey = correlationKey(input.privacy, "session", payload.session_id);
    const turnKey = correlationKey(input.privacy, "turn", payload.turn_id);
    return evidenceEventSchema.parse({
      schemaVersion: 1,
      id: input.id?.() ?? randomUUID(),
      createdAt: (input.now?.() ?? new Date()).toISOString(),
      kind: "turn-finished",
      harness,
      ...(input.preflightId ? { preflightId: input.preflightId } : {}),
      ...(sessionKey ? { sessionKey } : {}),
      ...(turnKey ? { turnKey } : {}),
      reason: turnReason(payload.reason)
    });
  }

  const payload = claudeLifecycleInputSchema.parse(raw);
  const sessionKey = correlationKey(input.privacy, "session", payload.session_id);
  if (payload.hook_event_name === "SessionEnd") {
    return evidenceEventSchema.parse({
      schemaVersion: 1,
      id: input.id?.() ?? randomUUID(),
      createdAt: (input.now?.() ?? new Date()).toISOString(),
      kind: "session-ended",
      harness,
      ...(sessionKey ? { sessionKey } : {}),
      reason: sessionReason(payload.reason)
    });
  }
  const preflightId = input.preflightId ?? latestOpenPreflightId(
    input.events ?? [],
    harness,
    sessionKey
  );
  return evidenceEventSchema.parse({
    schemaVersion: 1,
    id: input.id?.() ?? randomUUID(),
    createdAt: (input.now?.() ?? new Date()).toISOString(),
    kind: "turn-finished",
    harness,
    ...(preflightId ? { preflightId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    reason: "complete"
  });
}

export interface RunLifecycleHookInput extends NormalizeLifecycleInput {
  onEvent?(event: EvidenceEvent): Promise<void> | void;
}

export async function runLifecycleHook(input: RunLifecycleHookInput): Promise<Record<string, never>> {
  try {
    const event = normalizeLifecycleInput(input);
    await input.onEvent?.(event);
  } catch {
    // Lifecycle observation must never block or change the host Harness.
  }
  return {};
}
