import { PrismaClient } from "@prisma/client";

export * from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  __maggyboxPrisma?: PrismaClient;
};

/**
 * Lazily instantiate the Prisma client.
 *
 * The constructor must NOT run while this module is imported — Next.js
 * evaluates route modules during build-time page-data collection, where
 * `DATABASE_URL` may not be set (e.g. Vercel build step). Building the
 * client on first query keeps the build clean and the runtime connection
 * config unchanged.
 */
function createPrismaClient(): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: process.env.DATABASE_URL } },
  });
}

export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    if (!globalForPrisma.__maggyboxPrisma) {
      globalForPrisma.__maggyboxPrisma = createPrismaClient();
    }
    const client = globalForPrisma.__maggyboxPrisma as unknown as Record<
      string | symbol,
      unknown
    >;
    const value = Reflect.get(client, prop, client);
    return typeof value === "function" ? value.bind(client) : value;
  },
});

export { PrismaClient };
