import { execFile } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import { promisify } from "node:util";
import type { Logger } from "./logger.util";

const execFileAsync = promisify(execFile);

const OPENVPN_DEFAULT_CONFIG_PATH = "/etc/openvpn/openvpn.conf";
const OPENVPN_DEFAULT_AUTH_PATH = "/etc/openvpn/auth.txt";

type OpenVpnEnv = {
  enabled: boolean;
  config: string | undefined;
  configPath: string;
  authPath: string;
  username: string | undefined;
  password: string | undefined;
  extraArgs: string | undefined;
  wireguardEnabled: boolean;
};

const readEnv = (key: string): string | undefined =>
  process.env[key] ?? process.env[key.toLowerCase()];

const parseBool = (raw: string | undefined): boolean =>
  raw ? raw.toLowerCase() === "true" : false;

const getOpenVpnEnv = (): OpenVpnEnv => {
  const configPath =
    readEnv("OPENVPN_CONFIG_PATH") || OPENVPN_DEFAULT_CONFIG_PATH;
  return {
    enabled: parseBool(readEnv("OPENVPN_ENABLED")),
    config: readEnv("OPENVPN_CONFIG"),
    configPath,
    authPath: readEnv("OPENVPN_AUTH_PATH") || OPENVPN_DEFAULT_AUTH_PATH,
    username: readEnv("OPENVPN_USERNAME"),
    password: readEnv("OPENVPN_PASSWORD"),
    extraArgs: readEnv("OPENVPN_EXTRA_ARGS"),
    wireguardEnabled: parseBool(readEnv("WIREGUARD_ENABLED")),
  };
};

const ensureDirForFile = async (filePath: string): Promise<void> => {
  const lastSlash = filePath.lastIndexOf("/");
  if (lastSlash === -1) return;
  const dir = filePath.slice(0, lastSlash);
  await fs.mkdir(dir, { recursive: true });
};

const writeConfig = async (env: OpenVpnEnv): Promise<void> => {
  if (!env.config) {
    await fs.access(env.configPath, fsConstants.R_OK);
    return;
  }
  await ensureDirForFile(env.configPath);
  await fs.writeFile(
    env.configPath,
    `${env.config.trim()}
`,
    { mode: 0o600 },
  );
};

const writeAuth = async (env: OpenVpnEnv): Promise<boolean> => {
  if (!env.username || !env.password) {
    return false;
  }
  await ensureDirForFile(env.authPath);
  await fs.writeFile(
    env.authPath,
    `${env.username}
${env.password}
`,
    { mode: 0o600 },
  );
  return true;
};

const parseExtraArgs = (extraArgs: string | undefined): string[] => {
  if (!extraArgs) return [];
  return extraArgs.match(/\S+/g) ?? [];
};

export async function startOpenvpn(logger: Logger): Promise<boolean> {
  const env = getOpenVpnEnv();
  if (!env.enabled) {
    return false;
  }

  if (env.wireguardEnabled) {
    logger.warn("OPENVPN_ENABLED is true; WireGuard setup will be skipped.");
  }

  try {
    await writeConfig(env);
    const hasAuth = await writeAuth(env);

    if (!hasAuth && (env.username || env.password)) {
      throw new Error(
        "OPENVPN_USERNAME and OPENVPN_PASSWORD must both be set.",
      );
    }

    const args = ["--config", env.configPath, "--daemon", "polymarket-openvpn"];
    if (hasAuth) {
      args.push("--auth-user-pass", env.authPath);
    }
    args.push(...parseExtraArgs(env.extraArgs));

    await execFileAsync("openvpn", args);
    logger.info("OpenVPN started.");
    return true;
  } catch (err) {
    logger.error("Failed to start OpenVPN", err as Error);
    return false;
  }
}
