export type LogLevel = "debug" | "info" | "warn" | "error";

const rank: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  constructor(private readonly component: string, private readonly minimum: LogLevel = "info") {}

  debug(message: string, details?: Record<string, unknown>): void { this.write("debug", message, details); }
  info(message: string, details?: Record<string, unknown>): void { this.write("info", message, details); }
  warn(message: string, details?: Record<string, unknown>): void { this.write("warn", message, details); }
  error(message: string, details?: Record<string, unknown>): void { this.write("error", message, details); }

  private write(level: LogLevel, message: string, details?: Record<string, unknown>): void {
    if (rank[level] < rank[this.minimum]) return;
    const record = { timestamp: new Date().toISOString(), level, component: this.component, message, ...details };
    process.stderr.write(`${JSON.stringify(record)}\n`);
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
