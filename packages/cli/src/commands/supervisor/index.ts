import { defineCommand } from "citty";

export default defineCommand({
  meta: {
    name: "supervisor",
    description: "Supervisor management commands",
  },
  subCommands: {
    status: () => import("./status.js").then((m) => m.default),
  },
});
