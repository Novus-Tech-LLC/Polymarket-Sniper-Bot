import { execFile } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import { promisify } from "node:util";
import type { Logger } from "./logger.util";

const execFileAsync = promisify(execFile);

type WireguardEnv = {
  enabled: boolean;
  config: string | undefined;
  interfaceName: string;
  configPath: string;
  address: string | undefined;
  privateKey: string | undefined;
  mtu: string | undefined;
  dns: string | undefined;
  peerPublicKey: string | undefined;
  peerPresharedKey: string | undefined;
  peerEndpoint: string | undefined;
  allowedIps: string | undefined;
  persistentKeepalive: string | undefined;
  forceRestart: boolean;
};

const readEnv = (key: string): string | undefined =>
  process.env[key] ?? process.env[key.toLowerCase()];

const parseBool = (raw: string | undefined): boolean =>
  raw ? raw.toLowerCase() === "true" : false;

const getWireguardEnv = (): WireguardEnv => {
  const interfaceName = readEnv("WIREGUARD_INTERFACE_NAME") || "wg0";
  const configPath =
    readEnv("WIREGUARD_CONFIG_PATH") || `/etc/wireguard/${interfaceName}.conf`;
  return {
    enabled: parseBool(readEnv("WIREGUARD_ENABLED")),
    config: readEnv("WIREGUARD_CONFIG"),
    interfaceName,
    configPath,
    address: readEnv("WIREGUARD_ADDRESS"),
    privateKey: readEnv("WIREGUARD_PRIVATE_KEY"),
    mtu: readEnv("WIREGUARD_MTU"),
    dns: readEnv("WIREGUARD_DNS"),
    peerPublicKey: readEnv("WIREGUARD_PEER_PUBLIC_KEY"),
    peerPresharedKey: readEnv("WIREGUARD_PEER_PRESHARED_KEY"),
    peerEndpoint: readEnv("WIREGUARD_PEER_ENDPOINT"),
    allowedIps: readEnv("WIREGUARD_ALLOWED_IPS"),
    persistentKeepalive: readEnv("WIREGUARD_PERSISTENT_KEEPALIVE"),
    forceRestart: parseBool(readEnv("WIREGUARD_FORCE_RESTART")),
  };
};

const stripDnsLines = (config: string): string =>
  config
    .split(/\r?\n/)
    .filter((line) => !/^\s*DNS\s*=/i.test(line))
    .join("\n")
    .trim();

const buildConfig = (env: WireguardEnv, includeDns: boolean): string => {
  if (env.config) {
    return (includeDns ? env.config : stripDnsLines(env.config)).trim();
  }

  const missing = [
    ["WIREGUARD_ADDRESS", env.address],
    ["WIREGUARD_PRIVATE_KEY", env.privateKey],
    ["WIREGUARD_PEER_PUBLIC_KEY", env.peerPublicKey],
    ["WIREGUARD_PEER_ENDPOINT", env.peerEndpoint],
    ["WIREGUARD_ALLOWED_IPS", env.allowedIps],
  ].filter(([, value]) => !value);

  if (missing.length > 0) {
    const missingKeys = missing.map(([key]) => key).join(", ");
    throw new Error(`WireGuard enabled but missing env vars: ${missingKeys}`);
  }

  const lines = [
    "[Interface]",
    `Address = ${env.address ?? ""}`,
    `PrivateKey = ${env.privateKey ?? ""}`,
  ];

  if (env.mtu) {
    lines.push(`MTU = ${env.mtu}`);
  }
  if (includeDns && env.dns) {
    lines.push(`DNS = ${env.dns}`);
  }

  lines.push("", "[Peer]", `PublicKey = ${env.peerPublicKey ?? ""}`);

  if (env.peerPresharedKey) {
    lines.push(`PresharedKey = ${env.peerPresharedKey}`);
  }

  lines.push(
    `Endpoint = ${env.peerEndpoint ?? ""}`,
    `AllowedIPs = ${env.allowedIps ?? ""}`,
  );

  if (env.persistentKeepalive) {
    lines.push(`PersistentKeepalive = ${env.persistentKeepalive}`);
  }

  return lines.join("\n");
};

const ensureConfigDir = async (configPath: string): Promise<void> => {
  const lastSlash = configPath.lastIndexOf("/");
  if (lastSlash === -1) return;
  const dir = configPath.slice(0, lastSlash);
  await fs.mkdir(dir, { recursive: true });
};

const writeConfig = async (
  env: WireguardEnv,
  includeDns: boolean,
): Promise<void> => {
  const config = buildConfig(env, includeDns);
  await ensureConfigDir(env.configPath);
  await fs.writeFile(env.configPath, `${config}\n`, { mode: 0o600 });
};

const isResolvconfError = (err: unknown): boolean => {
  if (!(err instanceof Error)) {
    return false;
  }
  const message = err.message.toLowerCase();
  return (
    message.includes("resolvconf") ||
    message.includes("signature mismatch") ||
    message.includes("useable init system")
  );
};

const isMissingIp6tablesRestore = (err: unknown): boolean => {
  if (!(err instanceof Error)) {
    return false;
  }
  const message = err.message.toLowerCase();
  return (
    message.includes("ip6tables-restore") &&
    message.includes("command not found")
  );
};

const hasCommand = async (command: string): Promise<boolean> => {
  try {
    await execFileAsync("sh", ["-c", `command -v ${command}`]);
    return true;
  } catch {
    return false;
  }
};

/**
 * Known installation paths for resolvconf across different Linux distributions.
 * Order matters: /sbin is checked first as it's the standard location where
 * our Dockerfile creates a symlink. Alpine's openresolv installs to /usr/sbin.
 */
const RESOLVCONF_PATHS = [
  "/sbin/resolvconf",
  "/usr/sbin/resolvconf",
  "/usr/bin/resolvconf",
];

const hasResolvconf = async (): Promise<boolean> => {
  // First try command -v which searches PATH
  if (await hasCommand("resolvconf")) {
    return true;
  }
  // Fallback: check known installation paths directly
  for (const path of RESOLVCONF_PATHS) {
    try {
      await fs.access(path, fsConstants.X_OK);
      return true;
    } catch {
      // Path not found or not executable, try next
    }
  }
  return false;
};

const ensureResolvconfAvailable = async (
  logger: Logger,
  dns: string | undefined,
): Promise<void> => {
  if (!dns) {
    return;
  }

  if (await hasResolvconf()) {
    return;
  }

  try {
    if (await hasCommand("apk")) {
      logger.info("Installing openresolv to enable WireGuard DNS updates.");
      await execFileAsync("apk", ["add", "--no-cache", "openresolv"]);
      return;
    }
    if (await hasCommand("apt-get")) {
      logger.info("Installing resolvconf to enable WireGuard DNS updates.");
      await execFileAsync("sh", [
        "-c",
        "apt-get update && apt-get install -y resolvconf",
      ]);
      return;
    }
    if (await hasCommand("dnf")) {
      logger.info("Installing resolvconf to enable WireGuard DNS updates.");
      await execFileAsync("dnf", ["install", "-y", "resolvconf"]);
      return;
    }
    if (await hasCommand("yum")) {
      logger.info("Installing resolvconf to enable WireGuard DNS updates.");
      await execFileAsync("yum", ["install", "-y", "resolvconf"]);
      return;
    }
  } catch (err) {
    logger.warn(
      `Failed to install resolvconf automatically: ${(err as Error).message}`,
    );
    return;
  }

  logger.warn(
    "resolvconf is not installed and no supported package manager was found.",
  );
};

export async function startWireguard(logger: Logger): Promise<void> {
  const env = getWireguardEnv();
  if (!env.enabled) {
    return;
  }

  try {
    await ensureResolvconfAvailable(logger, env.dns);
    await writeConfig(env, true);

    if (env.forceRestart) {
      try {
        await execFileAsync("wg-quick", ["down", env.interfaceName]);
      } catch (err) {
        logger.warn(`WireGuard down skipped: ${(err as Error).message}`);
      }
    }

    try {
      await execFileAsync("wg-quick", ["up", env.interfaceName]);
      logger.info(`WireGuard interface ${env.interfaceName} is up.`);
    } catch (err) {
      if (isResolvconfError(err)) {
        const dnsHint = env.dns
          ? ` DNS from WIREGUARD_DNS (${env.dns}) will be ignored unless resolvconf/openresolv is installed.`
          : "";
        logger.warn(
          `WireGuard DNS setup failed via resolvconf; retrying without DNS.${dnsHint}`,
        );
        await writeConfig(env, false);
        try {
          await execFileAsync("wg-quick", ["up", env.interfaceName]);
          logger.info(
            `WireGuard interface ${env.interfaceName} is up (DNS disabled).`,
          );
        } catch (retryErr) {
          if (isMissingIp6tablesRestore(retryErr)) {
            logger.error(
              "WireGuard failed because ip6tables-restore is missing. Install iptables/ip6tables in the container or remove IPv6 entries from WIREGUARD_ADDRESS/WIREGUARD_ALLOWED_IPS.",
            );
            return;
          }
          throw retryErr;
        }
        return;
      }
      if (isMissingIp6tablesRestore(err)) {
        logger.error(
          "WireGuard failed because ip6tables-restore is missing. Install iptables/ip6tables in the container or remove IPv6 entries from WIREGUARD_ADDRESS/WIREGUARD_ALLOWED_IPS.",
        );
        return;
      }
      throw err;
    }
  } catch (err) {
    logger.error("Failed to start WireGuard", err as Error);
  }
}
