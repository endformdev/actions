import * as core from "@actions/core";

async function run() {
	try {
		// Get inputs
		const token = core.getInput("github-token", { required: true });

		// Hello World!
		console.log("Hello World from await-vercel-deployment!");

		core.setOutput("message", "Hello World from await-vercel-deployment!");
	} catch (error) {
		core.setFailed(error instanceof Error ? error.message : String(error));
	}
}

run();
