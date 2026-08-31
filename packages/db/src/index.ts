import { PrismaClient } from "@prisma/client";

export * from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  __maggyboxPrisma?: PrismaClient;
};

/**
 * Lazily construct the Prisma client on first use.
 *
 * This keeps module evaluation side-effect free: importing this module during
 * Vercel build-time page-data collection no longer constructs a client (which
 * previously threw PrismaClientConstructorValidationError when DATABASE_URL
 * was not set in the build environment).
 */
function getPrismaClient(): PrismaClient {
  if (!globalForPrisma.__maggyboxPrisma) {
    if (!process.env.DATABASE_URL) {
      // MAG-19: surface a misconfigured deployment early in the logs instead
      // of failing later with an opaque connection error on the first query.
      console.warn(
        "[db] DATABASE_URL is not set — Prisma queries will fail at runtime " +
          "(connection errors, e.g. P1001). Set DATABASE_URL in the deployment environment.",
      );
    }
    globalForPrisma.__maggyboxPrisma = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL } },
    });
  }
  return globalForPrisma.__maggyboxPrisma;
}

export const prisma = new Proxy<PrismaClient>({} as PrismaClient, {
  get(_target, prop) {
    const client = getPrismaClient() as unknown as Record<string | symbol, unknown>;
    const value = client[prop];
    return typeof value === "function" ? value.bind(client) : value;
  },
});

export { PrismaClient };
