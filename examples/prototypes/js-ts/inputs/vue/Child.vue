<script setup lang="ts">
const emit = defineEmits<{ select: [value: string] }>();
</script>
<template><button @click="emit('select', 'value')">Select</button></template>
