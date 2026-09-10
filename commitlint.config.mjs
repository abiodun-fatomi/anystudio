// Commit messages: type(scope): why — the shape this repo's log already has.
// The header may run long because these subjects say why, not what; the body
// is free-form prose.
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'header-max-length': [2, 'always', 140],
    'body-max-line-length': [0],
    'footer-max-line-length': [0],
    'subject-case': [0],
    'type-enum': [2, 'always', ['feat', 'fix', 'chore', 'docs', 'refactor', 'test', 'perf', 'ci', 'build', 'style', 'revert']],
  },
};
