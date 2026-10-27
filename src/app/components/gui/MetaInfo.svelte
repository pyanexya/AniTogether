<script>
    export let subTitle;
    export let title = "AnixArtix";
</script>

<svelte:head>
    <title>{subTitle ? `${subTitle} - ${title}` : title}</title>
</svelte:head>