import type { ProviderConfig } from "@/config/schema";
import type { ResolvedAgent } from "@/types";

export function validateAgentModels(agents: ResolvedAgent[], provider: ProviderConfig): void {
  for (const agent of agents) {
    if (agent.definition.model && !provider.models.available.includes(agent.definition.model)) {
      throw new Error(
        `Agent "${agent.name}" specifies model "${agent.definition.model}" ` +
          `which is not in provider.models.available: [${provider.models.available.join(", ")}]`,
      );
    }
  }
}
