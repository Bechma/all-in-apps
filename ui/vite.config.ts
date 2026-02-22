import devtoolsJson from 'vite-plugin-devtools-json';
import tailwindcss from '@tailwindcss/vite';
import {sveltekit} from '@sveltejs/kit/vite';
import {defineConfig, loadEnv} from 'vite';

export default defineConfig(({mode}) => {
    const env = loadEnv(mode, '.', '');
    const backendTarget = env.NOTES_BACKEND_URL || 'http://127.0.0.1:3000';

    return {
        plugins: [tailwindcss(), sveltekit(), devtoolsJson()],
        server: {
            proxy: {
                '/api': {
                    target: backendTarget,
                    changeOrigin: true,
                    ws: true
                },
                '/healthcheck': {
                    target: backendTarget,
                    changeOrigin: true
                }
            }
        }
    };
});
