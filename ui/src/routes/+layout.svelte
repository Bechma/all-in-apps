<script lang="ts">
	import './layout.css';
	import {QueryClient, QueryClientProvider} from '@tanstack/svelte-query';
	import favicon from '$lib/assets/favicon.svg';

	let {children} = $props();
    const queryClient = new QueryClient();
</script>

<svelte:head>
    <link rel="icon" href={favicon}/>
    <link rel="preconnect" href="https://fonts.googleapis.com"/>
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous"/>
    <link
            rel="stylesheet"
            href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,700&family=IBM+Plex+Sans:wght@400;500;600&display=swap"
    />
</svelte:head>
<QueryClientProvider client={queryClient}>
    {@render children()}
</QueryClientProvider>
