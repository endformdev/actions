import * as core from "@actions/core";

const ENDFORM_URL = "https://endform.dev";

async function run() {
	try {
		// Request token with your API as the audience
		const token = await getOIDCToken();

		core.info("Successfully obtained OIDC token");
		core.debug(`Token length: ${token.length}`);

		// Parse deployments input
		const projectName = core.getInput("project-name", { required: true });
		const setUrlEnvVar = core.getInput("set-url-env-var", { required: true });

		// Wait for deployments
		core.info("Waiting for Vercel deployments...");
		const result = await waitForVercelDeployment(token, projectName);

		core.exportVariable(setUrlEnvVar, result.url);
		core.setOutput("message", "Deployment ready");
	} catch (error) {
		core.setFailed(error instanceof Error ? error.message : String(error));
	}
}

async function waitForVercelDeployment(token: string, projectName: string) {
	const apiUrl = `${ENDFORM_URL}/api/integrations/v1/vercel/actions-deployments/${projectName}/wait`;

	const response = await fetch(apiUrl, {
		method: "GET",
		headers: {
			Authorization: `Bearer ${token}`,
		},
	});
	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(
			`Failed to wait for deployments: ${response.status} ${response.statusText}\n${errorText}`,
		);
	}

	return (await response.json()) as { url: string };
}

async function getOIDCToken(): Promise<string> {
	// Check if OIDC is configured in the workflow
	const tokenRequestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
	const tokenRequestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;

	if (!tokenRequestUrl || !tokenRequestToken) {
		throw new Error(
			"Unable to get OIDC token. Please ensure the workflow has 'id-token: write' permission configured:\n\n" +
				"permissions:\n" +
				"  id-token: write\n" +
				"  contents: read\n",
		);
	}

	const url = `${tokenRequestUrl}&audience=${encodeURIComponent(ENDFORM_URL)}`;

	const response = await fetch(url, {
		method: "GET",
		headers: {
			Authorization: `Bearer ${tokenRequestToken}`,
			Accept: "application/json",
		},
	});

	if (!response.ok) {
		throw new Error(
			`Failed to get OIDC token: ${response.status} ${response.statusText}`,
		);
	}

	const data = (await response.json()) as { value: string };
	if (!data.value) {
		throw new Error("Failed to get OIDC token: No value returned");
	}
	return data.value;
}

run();
