export {
  IntegrationError,
  applyIntegrationPlan,
  integrationPlanSchema,
  integrationStatus,
  planIntegration,
  removeIntegration,
  rethrowAfterIntegrationApplyFailure,
  rollbackIntegrationPlan
} from "./config.js";
export type {
  IntegrationChange,
  IntegrationConfigOptions,
  IntegrationErrorCode,
  IntegrationPlan,
  IntegrationStatus,
  IntegrationStatusValue
} from "./config.js";
export { copilotHookConfig, copilotHookTarget } from "./config-adapters.js";
export { companionSubplanSchema } from "./companion-domain.js";
export type { CompanionSubplan } from "./companion-domain.js";
export {
  CompanionSkillError,
  companionSkillDirectory,
  inspectCompanionSkill
} from "./companion-skill.js";
export type {
  CompanionSkillInspection,
  CompanionSkillStatus,
  InspectCompanionSkillInput
} from "./companion-skill.js";
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
