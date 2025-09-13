import { defineConfig } from 'drizzle-kit';

export default defineConfig({
    schema: './src/db/schema.ts',
    out: './migrations',
    dialect: 'mysql',
    dbCredentials: {
        url: process.env.DATABASE_URL || 'mysql://username_crypto_user:your_password@localhost:3306/username_crypto_scanner',
    },
    verbose: true,
});
