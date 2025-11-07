import * as core from "@actions/core";

const ENDFORM_URL = "https://endform.dev";

async function run() {
	try {
		core.info("Requesting OIDC token from GitHub...");

		// Request token with your API as the audience
		const token = await getOIDCToken();

		core.info("Successfully obtained OIDC token");
		core.debug(`Token length: ${token.length}`);

		// Register the check with your API
		core.info("Registering check with Endform API...");
		const result = await registerCheck(token);

		core.info("Check registered successfully!");
		core.setOutput("check-id", result.id);
		core.setOutput("message", "Check registered successfully");
	} catch (error) {
		core.setFailed(error instanceof Error ? error.message : String(error));
	}
}

async function registerCheck(token: string) {
	const response = await fetch(
		`${ENDFORM_URL}/api/integrations/v1/vercel/actions-deployments/register-check`,
		{
			method: "GET",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
			},
		},
	);

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(
			`Failed to register check: ${response.status} ${response.statusText}\n${errorText}`,
		);
	}

	return (await response.json()) as { id: string };
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
