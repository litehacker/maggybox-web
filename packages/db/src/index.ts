import { PrismaClient } from "@prisma/client";

export * from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  __maggyboxPrisma?: PrismaClient;
};

function createClient(): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: process.env.DATABASE_URL } },
  });
}

/**
 * Lazily-initialized Prisma client.
 *
 * The client is constructed on first use (first query) instead of at module
 * evaluation time. This keeps build-time page-data collection (e.g. Next.js
 * `next build`) from touching the database: with a module-level instantiation,
 * `PrismaClientConstructorValidationError` is thrown during the build when
 * DATABASE_URL is not present in the build environment.
 */
export const prisma = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    if (!globalForPrisma.__maggyboxPrisma) {
      globalForPrisma.__maggyboxPrisma = createClient();
    }
    const client = globalForPrisma.__maggyboxPrisma as unknown as Record<
      string | symbol,
      unknown
    >;
    const value = Reflect.get(client, prop, client);
    return typeof value === "function" ? value.bind(client) : value;
  },
}) as PrismaClient;

export { PrismaClient };
