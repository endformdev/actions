import * as core from "@actions/core";

const DEFAULT_ENDFORM_URL = "https://endform.dev";

async function run() {
	try {
		// Allow overriding Endform URL via environment variable (for testing)
		const endformUrl = process.env.ENDFORM_URL || DEFAULT_ENDFORM_URL;

		core.info("Requesting OIDC token from GitHub...");

		// Request token with the default Endform URL as the audience (always use production for OIDC)
		const token = await getOIDCToken();

		core.info("Successfully obtained OIDC token");
		core.debug(`Token length: ${token.length}`);

		// Register the check with your API
		core.info("Registering check with Endform API...");
		if (endformUrl !== DEFAULT_ENDFORM_URL) {
			core.info(`Using custom Endform URL: ${endformUrl}`);
		}
		await registerCheck(token, endformUrl);

		core.info("Check registered successfully!");
		core.setOutput("message", "Check registered successfully");
	} catch (error) {
		core.setFailed(error instanceof Error ? error.message : String(error));
	}
}

async function registerCheck(token: string, endformUrl: string) {
	// Get SHA from GitHub context
	const sha = process.env.GITHUB_SHA;
	if (!sha) {
		throw new Error("GITHUB_SHA environment variable is not set");
	}

	const response = await fetch(
		`${endformUrl}/api/integrations/v1/actions/register-vercel-check`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				sha,
			}),
		},
	);

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(
			`Failed to register check: ${response.status} ${response.statusText}\n${errorText}`,
		);
	}

	// The API returns 200 with no body on success
	return { success: true };
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

	const url = `${tokenRequestUrl}&audience=${encodeURIComponent(DEFAULT_ENDFORM_URL)}`;

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
