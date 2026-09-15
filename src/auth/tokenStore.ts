/**
 * Token persistence.
 *
 * Tokens live in a small JSON file (default ./.saxo-tokens.json, gitignored)
 * created with mode 0600 so only the owning Linux user can read it. We keep
 * them out of .env on purpose: .env is static config you edit by hand, while
 * tokens rotate on every refresh and are rewritten by the program.
 *
 * Nothing in this module ever logs a token value.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

export interface StoredTokens {
  /** Environment the tokens were issued for. Prevents mixing SIM and LIVE tokens. */
  env: "sim" | "live";
  accessToken: string;
  refreshToken: string;
  /** Unix epoch milliseconds when the access token expires. */
  accessExpiresAt: number;
  /** Unix epoch milliseconds when the refresh token expires (if Saxo told us). */
  refreshExpiresAt?: number;
  /** PKCE verifier from the login; Saxo requires it again on refresh. */
  codeVerifier: string;
  /** Optional base_uri returned by the token endpoint. */
  baseUri?: string;
}

export class TokenStore {
  constructor(private readonly filePath: string) {}

  get path(): string {
    return this.filePath;
  }

  async read(): Promise<StoredTokens | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<StoredTokens>;
      if (
        typeof parsed.accessToken !== "string" ||
        typeof parsed.refreshToken !== "string" ||
        typeof parsed.accessExpiresAt !== "number" ||
        typeof parsed.codeVerifier !== "string" ||
        (parsed.env !== "sim" && parsed.env !== "live")
      ) {
        return null;
      }
      return parsed as StoredTokens;
    } catch {
      return null;
    }
  }

  /**
   * Atomically write the token file with 0600 permissions: write to a temp
   * file in the same directory, then rename over the target. A crash mid-write
   * can never leave a half-written token file behind.
   */
  async write(tokens: StoredTokens): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(this.filePath)}.${process.pid}.tmp`);
    await fs.writeFile(tmp, JSON.stringify(tokens, null, 2) + "\n", { mode: 0o600 });
    await fs.chmod(tmp, 0o600); // belt and braces in case of a permissive umask
    await fs.rename(tmp, this.filePath);
  }

  async clear(): Promise<void> {
    try {
      await fs.unlink(this.filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}
