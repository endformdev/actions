import * as core from "@actions/core";

async function run() {
	try {
		// Hello World!
		console.log("Hello World from register-vercel-check!");

		core.setOutput("message", "Hello World from register-vercel-check!");
	} catch (error) {
		core.setFailed(error instanceof Error ? error.message : String(error));
	}
}

run();
