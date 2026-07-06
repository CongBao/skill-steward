import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const tscPath = createRequire(import.meta.url).resolve("typescript/bin/tsc");

const runtimeExports = [
  "CompanionSkillError",
  "IntegrationError",
  "IntegrationTransactionError",
  "applyIntegrationRecoveryPlan",
  "applyIntegrationPlan",
  "applyIntegrationDisconnect",
  "companionSkillDirectory",
  "copilotHookConfig",
  "copilotHookTarget",
  "integrationCapabilities",
  "integrationCapabilitySchema",
  "integrationHarnessSchema",
  "integrationRecoveryStatus",
  "integrationStatus",
  "normalizeLifecycleInput",
  "normalizeObserveInput",
  "normalizePromptDelivery",
  "planIntegration",
  "planIntegrationRecovery",
  "planIntegrationDisconnect",
  "promptHookInputSchema",
  "promptInjectionHarnessSchema",
  "removeLegacyIntegration",
  "renderPromptHook",
  "runLifecycleHook",
  "runObserveHook",
  "runPromptHook",
  "serializePublicIntegrationError"
].sort();

const declarationExports = [
  ...runtimeExports,
  "CompanionSkillStatus",
  "IntegrationCapability",
  "IntegrationArtifactRole",
  "IntegrationConfigOptions",
  "IntegrationErrorCode",
  "IntegrationHarness",
  "IntegrationLegacyRemovalReceipt",
  "IntegrationPlan",
  "IntegrationPlanAction",
  "IntegrationPlanAvailability",
  "IntegrationReadinessContext",
  "IntegrationRecoveryApplyOptions",
  "IntegrationRecoveryPlan",
  "IntegrationRecoveryPlanOptions",
  "IntegrationRecoveryReceipt",
  "IntegrationRecoveryStatus",
  "IntegrationRecoveryStatusOptions",
  "IntegrationTransactionOptions",
  "IntegrationTransactionReceipt",
  "IntegrationDisconnectPlan",
  "IntegrationStatus",
  "IntegrationStatusAvailability",
  "IntegrationStatusV2",
  "LifecyclePrivacy",
  "NormalizeLifecycleInput",
  "NormalizeObserveInput",
  "PromptDeliveryInput",
  "PromptHookInput",
  "PromptHookOutput",
  "PromptInjectionHarness",
  "PublicIntegrationError",
  "PublicIntegrationErrorCode",
  "RenderPromptHookInput",
  "RunLifecycleHookInput",
  "RunObserveHookInput",
  "RunPromptHookInput"
].sort();

let temporaryDirectory = "";
let builtIndex = "";
let builtDeclaration = "";
let builtConfigDeclaration = "";

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(join(packageRoot, ".tmp-public-api-"));
  const outputDirectory = join(temporaryDirectory, "build");
  const configPath = join(temporaryDirectory, "tsconfig.json");
  await writeFile(configPath, JSON.stringify({
    extends: join(packageRoot, "tsconfig.json"),
    compilerOptions: {
      declaration: true,
      noEmit: false,
      outDir: outputDirectory,
      rootDir: packageRoot,
      sourceMap: false
    },
    files: [join(packageRoot, "src", "index.ts")],
    include: []
  }), "utf8");
  await execFileAsync(process.execPath, [tscPath, "-p", configPath]);
  builtIndex = join(outputDirectory, "src", "index.js");
  builtDeclaration = join(outputDirectory, "src", "index.d.ts");
  builtConfigDeclaration = join(outputDirectory, "src", "config.d.ts");
}, 30_000);

afterAll(async () => {
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

describe("built package root", () => {
  it("exposes the exact approved runtime and declaration API", async () => {
    const runtime = await import(`${pathToFileURL(builtIndex).href}?test=${Date.now()}`);
    expect(Object.keys(runtime).sort()).toEqual(runtimeExports);

    const program = ts.createProgram([builtDeclaration], {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022
    });
    const source = program.getSourceFile(builtDeclaration);
    const symbol = source && program.getTypeChecker().getSymbolAtLocation(source);
    if (!symbol) throw new Error("Unable to inspect built package declarations");
    const exportedNames = program.getTypeChecker().getExportsOfModule(symbol)
      .map(({ name }) => name)
      .sort();
    expect(exportedNames).toEqual(declarationExports);

    const declarationText = await readFile(builtDeclaration, "utf8");
    expect(declarationText).not.toContain("export *");
    expect(declarationText).not.toMatch(
      /CompanionManifest|companionTree|compareCompanionPaths|createCompanionTreeManifest|IntegrationRecoveryArtifact|IntegrationRecoveryInspection|IntegrationRecoveryState|LegacyAlpha|resolveCompanionManagedProof/u
    );
    expect(declarationText).not.toContain("dependencyOverrides");

    const configDeclarationText = await readFile(builtConfigDeclaration, "utf8");
    expect(configDeclarationText).toContain(
      "interface IntegrationMutationConfigOptions extends IntegrationConfigOptions"
    );
    expect(configDeclarationText).toMatch(
      /rollbackIntegrationPlan\([^)]*options: IntegrationMutationConfigOptions/su
    );
    expect(configDeclarationText).toMatch(
      /removeIntegration\([^)]*options: IntegrationMutationConfigOptions/su
    );
  });

  it.each([
    "@skill-steward/integrations/config",
    "@skill-steward/integrations/companion-domain",
    "@skill-steward/integrations/companion-legacy",
    "@skill-steward/integrations/companion-manifest",
    "@skill-steward/integrations/companion-inspector-internal",
    "@skill-steward/integrations/companion-transaction",
    "@skill-steward/integrations/companion-native-capability",
    "@skill-steward/integrations/companion-owned-tree-native",
    "@skill-steward/integrations/integration-lifecycle"
  ])("does not export internal subpath %s", async (specifier) => {
    const script = `
      try {
        await import(process.argv[1]);
        process.exitCode = 2;
      } catch (error) {
        if (error?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
        process.stdout.write(error.code);
      }
    `;
    await expect(execFileAsync(process.execPath, [
      "--input-type=module",
      "-e",
      script,
      specifier
    ], { cwd: packageRoot })).resolves.toMatchObject({
      stdout: "ERR_PACKAGE_PATH_NOT_EXPORTED"
    });
  });

  it("keeps legacy allowlist identities out of public CLI and dashboard diagnostics", async () => {
    const manifest = JSON.parse(await readFile(new URL(
      "./fixtures/companion-legacy/alpha-0.3.0-alpha.1/manifest.posix.json",
      import.meta.url
    ), "utf8"));
    const publicSources = await Promise.all([
      readFile(new URL("../../cli/src/commands/integrate.ts", import.meta.url), "utf8"),
      readFile(new URL("../../dashboard-server/src/integration-services.ts", import.meta.url), "utf8")
    ]);
    for (const source of publicSources) {
      expect(source).not.toContain(manifest.fingerprint);
      expect(source).not.toContain("skill-steward-preflight@0.3.0-alpha.1");
    }
  });

  it("keeps public Win32 source-unprovable inspection reviewable and non-mutating", async () => {
    const home = await mkdtemp(join(tmpdir(), "steward-public-win32-home-"));
    const sourceDirectory = join(home, "package", "skill-steward-preflight");
    const stateDirectory = join(home, "state");
    const hookPath = join(home, ".codex", "hooks.json");
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(join(sourceDirectory, "SKILL.md"), "packaged\n", "utf8");

    const script = `
      Object.defineProperty(process, "platform", { value: "win32" });
      const api = await import(${JSON.stringify(pathToFileURL(builtIndex).href)});
      const [home, stateDirectory, sourceDirectory, hookPath] = process.argv.slice(1);
      const options = { home, stateDirectory, companionSourceDirectory: sourceDirectory };
      const plan = await api.planIntegration("codex", options);
      let applyCode = "RESOLVED";
      try {
        await api.applyIntegrationPlan(plan.planId, {
          ...options,
          generateReadiness: async () => { throw new Error("unreachable readiness"); }
        });
      } catch (error) {
        applyCode = error?.code ?? "UNKNOWN";
      }
      let hookExists = true;
      try {
        await (await import("node:fs/promises")).access(hookPath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        hookExists = false;
      }
      process.stdout.write(JSON.stringify({
        plan,
        applyCode,
        hookExists
      }));
    `;
    const { stdout } = await execFileAsync(process.execPath, [
      "--input-type=module",
      "-e",
      script,
      home,
      stateDirectory,
      sourceDirectory,
      hookPath
    ], { cwd: packageRoot });
    const result = JSON.parse(stdout);
    expect(result.plan).toMatchObject({
      schemaVersion: 1,
      action: "blocked",
      status: "unknown",
      availability: {
        state: "unavailable",
        available: false,
        reason: "COMPANION_SOURCE_UNPROVABLE"
      },
      targets: {
        hook: hookPath,
        companion: join(home, ".agents", "skills", "skill-steward-preflight")
      },
      fingerprintCategory: "unknown",
      artifacts: []
    });
    expect(JSON.stringify(result.plan)).not.toMatch(
      /backupPath|sourceDirectory|expectedBefore|proof|allowlist|identity/u
    );
    expect(result.applyCode).toBe("INTEGRATION_COMPANION_ACTION_UNAVAILABLE");
    expect(result.hookExists).toBe(false);
    await expect(access(hookPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
