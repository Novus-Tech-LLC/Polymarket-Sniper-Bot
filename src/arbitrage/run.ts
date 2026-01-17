import "dotenv/config";
import { parseCliOverrides } from "../config/loadConfig";
import { startArbitrageEngine } from "./runtime";

async function run(): Promise<void> {
  const overrides = parseCliOverrides(process.argv.slice(2));
  await startArbitrageEngine(overrides);
}

run().catch((err) => {
  console.error("Arbitrage runtime error", err);
  process.exit(1);
});
