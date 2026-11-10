<script setup lang="ts">
import Child from "./Child.vue";
const choice = "unresolved";
const notify = (value: string) => value;
</script>
<template>
  <Child @select="notify" />
  <component :is="choice" />
</template>
