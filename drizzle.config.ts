import { defineConfig } from 'drizzle-kit';

export default defineConfig({
    schema: './src/lib/db/schema.ts',
    out: './migrations',
    dialect: 'mysql',
    dbCredentials: {
        url: process.env.DATABASE_URL|| 'mysql://root:@localhost:3306/crypto_scanner',
    },
    verbose: true,
});
