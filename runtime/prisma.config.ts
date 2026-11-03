import { defineConfig, env } from "prisma/config";

const migrationUrl = new URL(env("DATABASE_URL"));
migrationUrl.searchParams.set("schema", "collaboration");

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: migrationUrl.toString() },
});
