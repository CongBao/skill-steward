export {
  IntegrationError
} from "./config.js";
export type {
  IntegrationConfigOptions,
  IntegrationErrorCode
} from "./config.js";
export {
  IntegrationTransactionError,
  applyIntegrationDisconnect,
  applyIntegrationPlan,
  integrationStatus,
  planIntegration,
  planIntegrationDisconnect,
  removeLegacyIntegration,
  serializePublicIntegrationError
} from "./integration-lifecycle.js";
export type {
  IntegrationArtifactRole,
  IntegrationDisconnectPlan,
  IntegrationLegacyRemovalReceipt,
  IntegrationPlan,
  IntegrationPlanAction,
  IntegrationPlanAvailability,
  IntegrationReadinessContext,
  IntegrationStatus,
  IntegrationTransactionOptions,
  IntegrationTransactionReceipt,
  PublicIntegrationError,
  PublicIntegrationErrorCode
} from "./integration-lifecycle.js";
export { copilotHookConfig, copilotHookTarget } from "./config-adapters.js";
export {
  CompanionSkillError,
  companionSkillDirectory
} from "./companion-skill.js";
export type { CompanionSkillStatus } from "./companion-skill.js";
export {
  integrationCapabilities,
  integrationCapabilitySchema,
  integrationHarnessSchema,
  promptHookInputSchema,
  promptInjectionHarnessSchema
} from "./domain.js";
export type {
  IntegrationCapability,
  IntegrationHarness,
  PromptHookInput,
  PromptHookOutput,
  PromptInjectionHarness
} from "./domain.js";
export { renderPromptHook, runPromptHook } from "./hook.js";
export type { RenderPromptHookInput, RunPromptHookInput } from "./hook.js";
export {
  normalizeLifecycleInput,
  normalizeObserveInput,
  normalizePromptDelivery,
  runLifecycleHook,
  runObserveHook
} from "./lifecycle.js";
export type {
  LifecyclePrivacy,
  NormalizeLifecycleInput,
  NormalizeObserveInput,
  PromptDeliveryInput,
  RunLifecycleHookInput,
  RunObserveHookInput
} from "./lifecycle.js";
