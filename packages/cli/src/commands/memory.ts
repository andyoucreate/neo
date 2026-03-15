import { defineCommand } from "citty";

export default defineCommand({
  meta: {
    name: "memory",
    description: "Inspect and search supervisor memory and knowledge",
  },
  subCommands: {
    search: () => import("./memory-search.js").then((m) => m.default),
    list: () => import("./memory-list.js").then((m) => m.default),
    show: () => import("./memory-show.js").then((m) => m.default),
  },
});
