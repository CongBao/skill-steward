export type IntegrationOperationState = "idle" | "reviewing" | "applying";

export interface IntegrationOperationToken {
  readonly generation: number;
  readonly operation: Exclude<IntegrationOperationState, "idle">;
}

export interface IntegrationOperationGuard {
  begin(operation: Exclude<IntegrationOperationState, "idle">): IntegrationOperationToken | null;
  commit(token: IntegrationOperationToken, update: () => void): boolean;
  finish(token: IntegrationOperationToken): boolean;
  invalidate(): void;
  state(): IntegrationOperationState;
}

export function createIntegrationOperationGuard(): IntegrationOperationGuard {
  let generation = 0;
  let active: IntegrationOperationToken | null = null;

  const isCurrent = (token: IntegrationOperationToken) => active !== null
    && active.generation === token.generation
    && active.operation === token.operation;

  return {
    begin(operation) {
      if (active) return null;
      generation += 1;
      active = { generation, operation };
      return active;
    },
    commit(token, update) {
      if (!isCurrent(token)) return false;
      update();
      return true;
    },
    finish(token) {
      if (!isCurrent(token)) return false;
      active = null;
      return true;
    },
    invalidate() {
      generation += 1;
      active = null;
    },
    state() {
      return active?.operation ?? "idle";
    }
  };
}
