// Legacy re-export — kept for backwards compatibility.
// New code should import from "@/supervisor/index" or "@neotx/core".
export type { SupervisorDaemonState as SupervisorState } from "./supervisor/schemas.js";
export { supervisorDaemonStateSchema as supervisorStateSchema } from "./supervisor/schemas.js";
