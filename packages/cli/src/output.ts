const NO_COLOR = !!process.env.NO_COLOR;

function ansi(code: string, text: string): string {
  return NO_COLOR ? text : `\x1b[${code}m${text}\x1b[0m`;
}

export function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

export function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const header = headers.map((h, i) => h.padEnd(widths[i] ?? 0)).join("  ");
  const separator = widths.map((w) => "─".repeat(w)).join("──");

  console.log(ansi("1", header));
  console.log(separator);
  for (const row of rows) {
    console.log(row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  "));
  }
}

export function printSuccess(msg: string): void {
  console.log(`${ansi("32", "✓")} ${msg}`);
}

export function printError(msg: string): void {
  process.stderr.write(`${ansi("31", "✗")} ${msg}\n`);
}
