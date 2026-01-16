import { loadMonitorConfig } from './loadConfig';

export type RuntimeEnv = ReturnType<typeof loadMonitorConfig>;

export function loadEnv(): RuntimeEnv {
  return loadMonitorConfig();
}
