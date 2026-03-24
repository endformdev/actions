import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["src/index.ts"],
	format: ["module"],
	platform: "node",
	target: "node24",
	clean: true,
});
