import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { promisify } from 'node:util';
import type { Logger } from './logger.util';

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

const readEnv = (key: string): string | undefined => process.env[key] ?? process.env[key.toLowerCase()];

const parseBool = (raw: string | undefined): boolean => (raw ? raw.toLowerCase() === 'true' : false);

const getWireguardEnv = (): WireguardEnv => {
  const interfaceName = readEnv('WIREGUARD_INTERFACE_NAME') || 'wg0';
  const configPath = readEnv('WIREGUARD_CONFIG_PATH') || `/etc/wireguard/${interfaceName}.conf`;
  return {
    enabled: parseBool(readEnv('WIREGUARD_ENABLED')),
    config: readEnv('WIREGUARD_CONFIG'),
    interfaceName,
    configPath,
    address: readEnv('WIREGUARD_ADDRESS'),
    privateKey: readEnv('WIREGUARD_PRIVATE_KEY'),
    mtu: readEnv('WIREGUARD_MTU'),
    dns: readEnv('WIREGUARD_DNS'),
    peerPublicKey: readEnv('WIREGUARD_PEER_PUBLIC_KEY'),
    peerPresharedKey: readEnv('WIREGUARD_PEER_PRESHARED_KEY'),
    peerEndpoint: readEnv('WIREGUARD_PEER_ENDPOINT'),
    allowedIps: readEnv('WIREGUARD_ALLOWED_IPS'),
    persistentKeepalive: readEnv('WIREGUARD_PERSISTENT_KEEPALIVE'),
    forceRestart: parseBool(readEnv('WIREGUARD_FORCE_RESTART')),
  };
};

const buildConfig = (env: WireguardEnv): string => {
  if (env.config) {
    return env.config.trim();
  }

  const missing = [
    ['WIREGUARD_ADDRESS', env.address],
    ['WIREGUARD_PRIVATE_KEY', env.privateKey],
    ['WIREGUARD_PEER_PUBLIC_KEY', env.peerPublicKey],
    ['WIREGUARD_PEER_ENDPOINT', env.peerEndpoint],
    ['WIREGUARD_ALLOWED_IPS', env.allowedIps],
  ].filter(([, value]) => !value);

  if (missing.length > 0) {
    const missingKeys = missing.map(([key]) => key).join(', ');
    throw new Error(`WireGuard enabled but missing env vars: ${missingKeys}`);
  }

  const lines = [
    '[Interface]',
    `Address = ${env.address ?? ''}`,
    `PrivateKey = ${env.privateKey ?? ''}`,
  ];

  if (env.mtu) {
    lines.push(`MTU = ${env.mtu}`);
  }
  if (env.dns) {
    lines.push(`DNS = ${env.dns}`);
  }

  lines.push('', '[Peer]', `PublicKey = ${env.peerPublicKey ?? ''}`);

  if (env.peerPresharedKey) {
    lines.push(`PresharedKey = ${env.peerPresharedKey}`);
  }

  lines.push(`Endpoint = ${env.peerEndpoint ?? ''}`, `AllowedIPs = ${env.allowedIps ?? ''}`);

  if (env.persistentKeepalive) {
    lines.push(`PersistentKeepalive = ${env.persistentKeepalive}`);
  }

  return lines.join('\n');
};

const ensureConfigDir = async (configPath: string): Promise<void> => {
  const lastSlash = configPath.lastIndexOf('/');
  if (lastSlash === -1) return;
  const dir = configPath.slice(0, lastSlash);
  await fs.mkdir(dir, { recursive: true });
};

export async function startWireguard(logger: Logger): Promise<void> {
  const env = getWireguardEnv();
  if (!env.enabled) {
    return;
  }

  try {
    const config = buildConfig(env);
    await ensureConfigDir(env.configPath);
    await fs.writeFile(env.configPath, `${config}\n`, { mode: 0o600 });

    if (env.forceRestart) {
      try {
        await execFileAsync('wg-quick', ['down', env.interfaceName]);
      } catch (err) {
        logger.warn(`WireGuard down skipped: ${(err as Error).message}`);
      }
    }

    await execFileAsync('wg-quick', ['up', env.interfaceName]);
    logger.info(`WireGuard interface ${env.interfaceName} is up.`);
  } catch (err) {
    logger.error('Failed to start WireGuard', err as Error);
  }
}
