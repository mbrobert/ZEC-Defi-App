import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The Base Sepolia addresses the rehearsal suite runs against, read from docs/DEPLOYMENTS.md —
 * the one place a deployed address may come from. `null` while the table holds no addresses,
 * which is what makes `sepolia.spec.ts` skip by name instead of failing or, worse, running
 * against nothing.
 */
// `__dirname`, not `import.meta.url`: Playwright loads TypeScript as CommonJS and so does the web's
// node:test runner (web/test/model-numbers.test.ts resolves the same way).
export const DEPLOYMENTS_PATH = join(__dirname, "../../docs/DEPLOYMENTS.md");

export interface SepoliaDeployment {
  factory: string;
  router: string;
  cbzec: string;
  aero: string;
  block: string | null;
}

const ADDRESS = /0x[0-9a-fA-F]{40}/;

function rowValue(section: string, key: string): string | null {
  const re = new RegExp(`^\\| ${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\|([^|]*)\\|`, "m");
  const m = section.match(re);
  return m ? m[1].trim() : null;
}

export function readSepoliaDeployment(path: string = DEPLOYMENTS_PATH): SepoliaDeployment | null {
  if (!existsSync(path)) return null;
  const doc = readFileSync(path, "utf8");
  const start = doc.indexOf("## Base Sepolia");
  if (start < 0) return null;
  const rest = doc.slice(start + 1);
  const next = rest.search(/\n## /);
  const section = next < 0 ? rest : rest.slice(0, next);
  const addr = (key: string) => {
    const v = rowValue(section, key);
    const m = v?.match(ADDRESS);
    return m ? m[0] : null;
  };
  const factory = addr("OilskinAccountFactory");
  const router = addr("StrategyRouter");
  const cbzec = addr("cbZEC double (MockB20)");
  const aero = addr("AERO double (MockERC20)");
  if (!factory || !router || !cbzec || !aero) return null;
  const block = rowValue(section, "deployedAtBlock");
  return { factory, router, cbzec, aero, block: block && /^\d+$/.test(block) ? block : null };
}
