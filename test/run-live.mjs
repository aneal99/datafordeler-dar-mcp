// Runs the suite with LIVE=1 on any platform (the `VAR=1 cmd` form does not work on Windows).
// Network tests hit services.datafordeler.dk; GraphQL tests also need DATAFORDELER_API_KEY.
import { spawnSync } from "node:child_process";

const result = spawnSync(process.execPath, ["--test", "test/normalise.test.mjs", "test/server.test.mjs"], {
  stdio: "inherit",
  env: { ...process.env, LIVE: "1" },
});
process.exit(result.status ?? 1);
