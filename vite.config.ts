import { defineConfig } from 'vite';
import { VitePluginNode } from 'vite-plugin-node';
import { execSync } from 'child_process';
import dts from 'vite-plugin-dts';

let gitInfo = {
    branch: '',
    commit: '',
    tags: '',
    commitDate: '',
};

try {
    gitInfo = {
        branch: execSync('git rev-parse --abbrev-ref HEAD').toString().trim(),
        commit: execSync('git rev-parse --short HEAD').toString().trim(),
        tags: '',
        commitDate: execSync('git log -1 --format=%cd --date=iso').toString().trim(),
    };

    try {
        gitInfo.tags = execSync('git tag --points-at HEAD | paste -sd "," -').toString().trim();
    } catch {
        gitInfo.tags = '';
    }
} catch {
    // eslint-disable-next-line no-console
    console.log('Directory does not have a Git repository, skipping git info');
}

export default defineConfig({
    server: {
        port: 3000
    },
    plugins: [
        ...VitePluginNode({
            adapter: 'express',
            appPath: './src/index.ts',
            exportName: 'viteNodeApp',
            tsCompiler: 'swc',
            swcOptions: {
                sourceMaps: true,
            },
        }),
        dts({
            include: ['src/**/*'],
            exclude: ['tests/**/*', 'node_modules/**/*'],
            outDir: 'dist',
            insertTypesEntry: true,
        }),
    ],
    build: {
        target: 'esnext',
        outDir: 'dist',
        lib: {
            entry: './src/index.ts',
            formats: ['es'],
            fileName: 'index',
        },
        rollupOptions: {
            external: [
                // Node.js built-ins
                'fs',
                'fs/promises',
                'path',
                'os',
                'child_process',
                'util',
                // External packages
                '@grunnverk/core',
                '@grunnverk/commands-git',
                '@grunnverk/tree-core',
                '@grunnverk/tree-execution',
                '@grunnverk/git-tools',
                '@grunnverk/shared',
            ],
        },
        // Make sure Vite generates ESM-compatible code
        modulePreload: false,
        minify: false,
        sourcemap: true
    },
});
