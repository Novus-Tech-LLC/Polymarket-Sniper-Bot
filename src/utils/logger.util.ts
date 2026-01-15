import chalk from 'chalk';

export interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string, err?: Error) => void;
  debug: (msg: string) => void;
}

const DEBUG_LEVELS = new Set(['', 'debug', 'trace']);

const shouldLogDebug = (): boolean => {
  const logLevel = (process.env.LOG_LEVEL ?? '').toLowerCase();
  if (process.env.DEBUG === '1') {
    return true;
  }
  return DEBUG_LEVELS.has(logLevel);
};

export class ConsoleLogger implements Logger {
  info(msg: string): void {
    // eslint-disable-next-line no-console
    console.log(chalk.cyan('[INFO]'), msg);
  }
  warn(msg: string): void {
    // eslint-disable-next-line no-console
    console.warn(chalk.yellow('[WARN]'), msg);
  }
  error(msg: string, err?: Error): void {
    // eslint-disable-next-line no-console
    console.error(chalk.red('[ERROR]'), msg, err ? `\n${err.stack ?? err.message}` : '');
  }
  debug(msg: string): void {
    if (shouldLogDebug()) {
      // eslint-disable-next-line no-console
      console.debug(chalk.gray('[DEBUG]'), msg);
    }
  }
}
