// One-time setup after cloning: create each package's .env from its
// .env.example (an existing .env is never overwritten), then npm install in
// every package. Safe to run again.
//
//   npm run setup

import { copyFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const packages = [".", "gateway", "services/products", "services/cart", "services/orders", "services/search", "frontend"];

for (const dir of packages) {
  const example = join(dir, ".env.example");
  const env = join(dir, ".env");
  if (existsSync(example) && !existsSync(env)) {
    copyFileSync(example, env);
    console.log(`created ${env}`);
  }

  console.log(`\nnpm install in ${dir}`);
  const result = spawnSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: dir, stdio: "inherit", shell: true });
  if (result.status !== 0) {
    console.error(`npm install failed in ${dir}`);
    process.exit(result.status ?? 1);
  }
}

console.log("\nDone. Next: npm run dev, then npm run seed and npm run sale -- 10 (see docs/try-it.md).");
