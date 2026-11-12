import {defineConfig} from 'vite';

export default defineConfig({
  server: {
    fs: {
      deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/*.key', '**/.agent-ledger.json*'],
    },
  },
});
