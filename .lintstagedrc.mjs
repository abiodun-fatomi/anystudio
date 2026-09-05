// What runs on the files staged for a commit. ESLint fixes what it can,
// Prettier settles the rest; both touch only the staged files, so a hook
// never rewrites code you did not change.
export default {
  '*.{ts,tsx,js,mjs,cjs}': ['eslint --fix --max-warnings 0', 'prettier --write'],
  '*.{css,json,md,yml,yaml}': ['prettier --write'],
  'packages/db/prisma/schema.prisma': ['pnpm --filter @anystudio/db exec prisma format'],
};
