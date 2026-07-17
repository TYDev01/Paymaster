/**
 * Mints an API key.
 *
 *   npm run key:generate -- --env live --name "acme dApp" --roles sponsor
 *
 * Prints the secret to stdout ONCE. Nothing recoverable is stored anywhere, by design: the record
 * a store would hold contains only the hash, so a lost key is reissued, never recovered.
 *
 * The secret goes to stdout and the human-readable framing to stderr, so a caller can pipe the key
 * somewhere useful without scraping it out of prose.
 */
import {generateApiKey, type KeyEnvironment} from "../auth/apiKey.js";
import {isRole, ROLE_NAMES, type Role} from "../auth/permissions.js";

interface Args {
  environment: KeyEnvironment;
  name: string;
  roles: readonly Role[];
}

export function parseArgs(argv: readonly string[]): Args {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  const environment = get("--env") ?? "live";
  if (environment !== "live" && environment !== "test") {
    throw new Error(`--env must be "live" or "test", got "${environment}"`);
  }

  const roles = (get("--roles") ?? "sponsor").split(",").map((r) => r.trim());
  for (const role of roles) {
    if (!isRole(role)) throw new Error(`unknown role "${role}"; valid roles: ${ROLE_NAMES.join(", ")}`);
  }

  return {
    environment,
    name: get("--name") ?? "unnamed key",
    roles: roles as readonly Role[],
  };
}

export function main(argv: readonly string[] = process.argv.slice(2)): void {
  const args = parseArgs(argv);
  const key = generateApiKey(args.environment);

  process.stderr.write(
    [
      "",
      `  name    ${args.name}`,
      `  env     ${args.environment}`,
      `  roles   ${args.roles.join(", ")}`,
      `  prefix  ${key.displayPrefix}...`,
      `  hash    ${key.hash}`,
      "",
      "  Secret (shown once — it is not stored and cannot be recovered):",
      "",
    ].join("\n"),
  );

  process.stdout.write(`${key.secret}\n`);

  process.stderr.write(
    [
      "",
      "  To use as the bootstrap admin key, set:",
      "    BOOTSTRAP_API_KEY=<the secret above>",
      "",
      "  Only its hash is stored. Treat the secret like a password.",
      "",
    ].join("\n"),
  );
}

if (process.argv[1] !== undefined && process.argv[1].endsWith("generateKey.ts")) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
