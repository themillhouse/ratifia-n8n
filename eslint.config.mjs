import { config } from '@n8n/node-cli/eslint';

// The node rules are for code that runs inside n8n. Tests run in vitest and
// read fixture files, which those rules forbid.
export default [{ ignores: ['dist/**', 'test/**'] }, ...config];
