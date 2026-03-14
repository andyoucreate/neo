import { render } from "ink";
import React from "react";
import { SupervisorTui } from "./supervisor-tui.js";

/**
 * Render the supervisor TUI. Returns a promise that resolves when the user exits.
 */
export async function renderSupervisorTui(name: string): Promise<void> {
  const { waitUntilExit } = render(React.createElement(SupervisorTui, { name }));
  await waitUntilExit();
}
