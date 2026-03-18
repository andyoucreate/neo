import { defineCommand } from "citty";

export default defineCommand({
  meta: {
    name: "supervisor",
    description: "Supervisor status and activity",
  },
  subCommands: {
    status: () => import("./status.js").then((m) => m.default),
    activity: () => import("./activity.js").then((m) => m.default),
  },
});
