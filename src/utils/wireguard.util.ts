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
    message.includes("useable init system") ||
    message.includes("unable to set dns")
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

/**
 * Directly applies DNS configuration to /etc/resolv.conf as a fallback when
 * resolvconf-based DNS setup fails. This handles cases where resolvconf is
 * installed but fails due to container restrictions (e.g., Docker's management
 * of /etc/resolv.conf).
 *
 * @param logger - Logger instance for status messages
 * @param dns - DNS server addresses from WIREGUARD_DNS (comma-separated)
 * @returns true if DNS was successfully applied, false otherwise
 */
const applyDnsFallback = async (
  logger: Logger,
  dns: string | undefined,
): Promise<boolean> => {
  if (!dns) {
    return false;
  }

  const RESOLV_CONF = "/etc/resolv.conf";
  const dnsServers = dns
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (dnsServers.length === 0) {
    return false;
  }

  try {
    // Read existing resolv.conf to preserve search/domain entries
    let existingContent = "";
    try {
      existingContent = await fs.readFile(RESOLV_CONF, "utf-8");
    } catch (readErr) {
      // File not found is expected; other errors are logged but not fatal
      const isNotFound =
        readErr instanceof Error &&
        "code" in readErr &&
        readErr.code === "ENOENT";
      if (!isNotFound) {
        logger.warn(`Could not read ${RESOLV_CONF}: ${(readErr as Error).message}`);
      }
    }

    // Preserve non-nameserver lines (search, domain, options)
    // Also filter out any existing WireGuard DNS markers (case-insensitive)
    const wgMarkerPattern = /^#\s*wireguard\s*dns\s*$/i;
    const preservedLines = existingContent
      .split(/\r?\n/)
      .filter(
        (line) =>
          !line.trim().startsWith("nameserver") &&
          !wgMarkerPattern.test(line.trim()) &&
          line.trim().length > 0,
      );

    // Build new content with WireGuard DNS servers at the top
    const wgMarker = "# WireGuard DNS";
    const nameserverLines = dnsServers.map((s) => `nameserver ${s}`);
    const newContent = [wgMarker, ...nameserverLines, ...preservedLines].join(
      "\n",
    );

    await fs.writeFile(RESOLV_CONF, `${newContent}\n`);
    logger.info(
      `DNS applied directly to ${RESOLV_CONF}: ${dnsServers.join(", ")}`,
    );
    return true;
  } catch (err) {
    // /etc/resolv.conf may be read-only in some container configurations
    logger.warn(
      `Failed to apply DNS directly to ${RESOLV_CONF}: ${(err as Error).message}`,
    );
    return false;
  }
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

/**
 * Checks if /etc/resolv.conf appears to be writable, indicating we can apply
 * DNS directly without needing resolvconf.
 */
const canWriteResolvConf = async (): Promise<boolean> => {
  try {
    await fs.access("/etc/resolv.conf", fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
};

export async function startWireguard(logger: Logger): Promise<void> {
  const env = getWireguardEnv();
  if (!env.enabled) {
    return;
  }

  try {
    // In container environments, /etc/resolv.conf is often managed by the runtime
    // and writable. In such cases, we can skip resolvconf entirely and apply DNS
    // directly, avoiding unnecessary warnings.
    const preferDirectDns = env.dns && (await canWriteResolvConf());

    if (!preferDirectDns) {
      await ensureResolvconfAvailable(logger, env.dns);
    }

    // Write config without DNS if we'll apply it directly
    await writeConfig(env, !preferDirectDns);

    if (env.forceRestart) {
      try {
        await execFileAsync("wg-quick", ["down", env.interfaceName]);
      } catch (err) {
        logger.warn(`WireGuard down skipped: ${(err as Error).message}`);
      }
    }

    try {
      await execFileAsync("wg-quick", ["up", env.interfaceName]);
      // If we preferred direct DNS, apply it now
      if (preferDirectDns) {
        const dnsFallbackApplied = await applyDnsFallback(logger, env.dns);
        if (dnsFallbackApplied) {
          logger.info(
            `WireGuard interface ${env.interfaceName} is up (DNS applied directly).`,
          );
        } else {
          logger.info(
            `WireGuard interface ${env.interfaceName} is up (DNS disabled).`,
          );
        }
      } else {
        logger.info(`WireGuard interface ${env.interfaceName} is up.`);
      }
    } catch (err) {
      if (isResolvconfError(err)) {
        logger.warn(
          `WireGuard DNS setup failed via resolvconf (this may happen when /etc/resolv.conf is managed by the container runtime).`,
        );
        await writeConfig(env, false);
        try {
          await execFileAsync("wg-quick", ["up", env.interfaceName]);
          // WireGuard is up without DNS, try to apply DNS directly
          const dnsFallbackApplied = await applyDnsFallback(logger, env.dns);
          if (dnsFallbackApplied) {
            logger.info(
              `WireGuard interface ${env.interfaceName} is up (DNS applied directly).`,
            );
          } else {
            logger.info(
              `WireGuard interface ${env.interfaceName} is up (DNS disabled).`,
            );
          }
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
