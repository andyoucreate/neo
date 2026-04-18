import { SUPPORTED_MODELS } from "@/models";
import type { ResolvedAgent } from "@/types";

export function validateAgentModels(agents: ResolvedAgent[]): void {
  const supported = Object.keys(SUPPORTED_MODELS);
  for (const agent of agents) {
    if (agent.definition.model && !SUPPORTED_MODELS[agent.definition.model]) {
      throw new Error(
        `Agent "${agent.name}" specifies model "${agent.definition.model}" ` +
          `which is not supported. Supported models: [${supported.join(", ")}]`,
      );
    }
  }
}
