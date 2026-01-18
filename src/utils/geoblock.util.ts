import { POLYMARKET_API } from "../constants/polymarket.constants";
import { httpGet } from "./fetch-data.util";
import type { Logger } from "./logger.util";

// Flag to prevent duplicate geoblock log messages
let geoblockLogged = false;

/**
 * Response from the Polymarket geoblock API
 * @see https://docs.polymarket.com/developers/CLOB/geoblock
 */
export interface GeoblockResponse {
  blocked: boolean;
  ip: string;
  country: string;
  region: string;
}

/**
 * Check if the current IP is geographically blocked from trading on Polymarket.
 * Trading is restricted in certain countries and regions per Polymarket's compliance requirements.
 *
 * @see https://docs.polymarket.com/developers/CLOB/geoblock
 * @returns GeoblockResponse containing blocked status and location info
 */
export async function checkGeoblock(): Promise<GeoblockResponse> {
  return httpGet<GeoblockResponse>(POLYMARKET_API.GEOBLOCK_ENDPOINT);
}

/**
 * Check if the current IP is geographically blocked and log the result.
 * Returns true if blocked (trading not allowed), false if allowed.
 *
 * SECURITY NOTE: By default, this function fails CLOSED - if the geoblock API
 * is unreachable, it returns true (blocked) to prevent potential compliance violations.
 * Set failOpen=true to allow trading when the API is unavailable (not recommended).
 *
 * @param logger - Logger instance for output
 * @param failOpen - If true, allow trading when API is unreachable (default: false)
 * @returns true if blocked, false if allowed
 */
export async function isGeoblocked(
  logger?: Logger,
  failOpen = false,
): Promise<boolean> {
  try {
    const response = await checkGeoblock();

    if (response.blocked) {
      if (!geoblockLogged) {
        logger?.warn(
          `[Geoblock] Trading restricted: country=${response.country} region=${response.region} ip=${response.ip}`,
        );
        geoblockLogged = true;
      }
      return true;
    }

    if (!geoblockLogged) {
      logger?.info(
        `[Geoblock] Trading allowed: country=${response.country} region=${response.region}`,
      );
      geoblockLogged = true;
    }
    return false;
  } catch (error) {
    // If we can't reach the geoblock API, fail closed by default for security
    const message = error instanceof Error ? error.message : String(error);
    if (failOpen) {
      if (!geoblockLogged) {
        logger?.warn(
          `[Geoblock] Unable to verify geographic eligibility (failOpen=true): ${message}`,
        );
        geoblockLogged = true;
      }
      return false;
    }
    if (!geoblockLogged) {
      logger?.error(
        `[Geoblock] Unable to verify geographic eligibility, blocking as precaution: ${message}`,
      );
      geoblockLogged = true;
    }
    return true;
  }
}

/**
 * Verify geographic eligibility and throw if blocked.
 * Use this for strict enforcement before trading operations.
 *
 * SECURITY NOTE: If the geoblock API is unreachable, this function throws
 * a compliance error to prevent potential geographic restriction violations.
 *
 * @param logger - Logger instance for output
 * @throws Error if user is geographically blocked or API is unreachable
 */
export async function verifyGeographicEligibility(
  logger?: Logger,
): Promise<void> {
  let response: GeoblockResponse;
  try {
    response = await checkGeoblock();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger?.error(
      `[Geoblock] Unable to verify geographic eligibility, blocking as precaution: ${message}`,
    );
    throw new Error(
      "Geographic eligibility verification failed - unable to reach geoblock API",
    );
  }

  if (response.blocked) {
    const message = `Trading not available in ${response.country}${response.region ? ` (${response.region})` : ""}`;
    logger?.error(`[Geoblock] ${message}`);
    throw new Error(message);
  }

  logger?.info(
    `[Geoblock] Geographic eligibility verified: country=${response.country}`,
  );
}
