import config from '@iobroker/eslint-config';
import globals from 'globals';

export default [
    ...config,
    {
        ignores: ['.dev-server/**'],
    },
    {
        files: ['**/*.js'],
        rules: {
            'jsdoc/check-tag-names': ['warn', { typed: false }],
        },
    },

    // Add mocha globals for test files
    {
        files: ['**/*.test.js', 'test/**/*.js'],
        languageOptions: {
            globals: {
                ...globals.mocha,
            },
        },
    },
];
