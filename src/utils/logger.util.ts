import chalk from "chalk";

export interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string, err?: Error) => void;
  debug: (msg: string) => void;
}

const DEBUG_LEVELS = new Set(["", "debug", "trace"]);

const shouldLogDebug = (): boolean => {
  const read = (key: string): string | undefined =>
    process.env[key] ?? process.env[key.toLowerCase()];
  const logLevel = (read("LOG_LEVEL") ?? "").toLowerCase();
  if (read("DEBUG") === "1") {
    return true;
  }
  return DEBUG_LEVELS.has(logLevel);
};

export class ConsoleLogger implements Logger {
  info(msg: string): void {
    console.log(chalk.cyan("[INFO]"), msg);
  }
  warn(msg: string): void {
    console.warn(chalk.yellow("[WARN]"), msg);
  }
  error(msg: string, err?: Error): void {
    console.error(
      chalk.red("[ERROR]"),
      msg,
      err ? `\n${err.stack ?? err.message}` : "",
    );
  }
  debug(msg: string): void {
    if (shouldLogDebug()) {
      console.debug(chalk.gray("[DEBUG]"), msg);
    }
  }
}
