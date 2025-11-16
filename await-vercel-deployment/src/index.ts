import * as core from "@actions/core";

const DEFAULT_ENDFORM_URL = "https://endform.dev";
const DEFAULT_TIMEOUT_SECONDS = 600; // 10 minutes
const POLL_INTERVAL_MS = 5000; // 5 seconds

interface DeploymentStatusResponse {
	deploymentId: string;
	status:
		| "BUILDING"
		| "ERROR"
		| "INITIALIZING"
		| "QUEUED"
		| "READY"
		| "CANCELED";
	deploymentURL: string | null;
}

async function run() {
	try {
		// Get inputs
		const projectName = core.getInput("project-name");
		const projectId = core.getInput("project-id");
		const setUrlEnvVar = core.getInput("set-url-env-var", { required: true });
		const timeoutSeconds = Number.parseInt(
			core.getInput("timeout-seconds") || String(DEFAULT_TIMEOUT_SECONDS),
			10,
		);
		// Allow overriding Endform URL via environment variable (for testing)
		const endformUrl = process.env.ENDFORM_URL || DEFAULT_ENDFORM_URL;

		// Request token with the default Endform URL as the audience (always use production for OIDC)
		const token = await getOIDCToken();

		core.info("Successfully obtained OIDC token");
		core.debug(`Token length: ${token.length}`);

		// Validate that at least one project identifier is provided
		if (!projectName && !projectId) {
			throw new Error(
				"Either 'project-name' or 'project-id' input must be provided",
			);
		}

		if (Number.isNaN(timeoutSeconds) || timeoutSeconds <= 0) {
			throw new Error("'timeout-seconds' must be a positive number");
		}

		// Get SHA from GitHub context
		const sha = process.env.GITHUB_SHA;
		if (!sha) {
			throw new Error("GITHUB_SHA environment variable is not set");
		}

		// Get job name from GitHub context
		const jobName = process.env.GITHUB_JOB;
		if (!jobName) {
			throw new Error("GITHUB_JOB environment variable is not set");
		}

		// Wait for deployments
		core.info(`Waiting for Vercel deployment (${projectName || projectId})...`);
		core.info(`Timeout: ${timeoutSeconds} seconds`);
		if (endformUrl !== DEFAULT_ENDFORM_URL) {
			core.info(`Using custom Endform URL: ${endformUrl}`);
		}

		const result = await waitForVercelDeployment(
			token,
			sha,
			jobName,
			projectName || null,
			projectId || null,
			timeoutSeconds,
			endformUrl,
		);

		core.exportVariable(setUrlEnvVar, result.deploymentURL);
		core.setOutput("deployment-url", result.deploymentURL);
		core.setOutput("deployment-id", result.deploymentId);
		core.setOutput("message", "Deployment ready");

		core.info(`Deployment ready: ${result.deploymentURL}`);
	} catch (error) {
		core.setFailed(error instanceof Error ? error.message : String(error));
	}
}

async function waitForVercelDeployment(
	token: string,
	sha: string,
	jobName: string,
	projectName: string | null,
	projectId: string | null,
	timeoutSeconds: number,
	endformUrl: string,
): Promise<DeploymentStatusResponse> {
	const apiUrl = `${endformUrl}/api/integrations/v1/actions/await-vercel-deployment`;
	const startTime = Date.now();
	const timeoutMs = timeoutSeconds * 1000;

	while (true) {
		// Check if we've exceeded the timeout
		if (Date.now() - startTime > timeoutMs) {
			throw new Error(
				`Timeout waiting for deployment after ${timeoutSeconds} seconds`,
			);
		}

		try {
			const response = await fetch(apiUrl, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					sha,
					jobName,
					vercelProjectName: projectName,
					vercelProjectId: projectId,
				}),
			});

			if (response.status === 404) {
				// Deployment not found yet, continue polling
				core.info("Deployment not found yet, will retry...");
				await sleep(POLL_INTERVAL_MS);
				continue;
			}

			if (response.status === 403) {
				// Authorization error - don't retry
				const errorText = await response.text();
				throw new Error(
					`Authorization failed: ${response.status} ${response.statusText}\n${errorText}`,
				);
			}

			if (response.status === 400) {
				// Bad request - don't retry
				const errorText = await response.text();
				throw new Error(
					`Bad request: ${response.status} ${response.statusText}\n${errorText}`,
				);
			}

			if (!response.ok) {
				// Other error - retry
				const errorText = await response.text();
				core.warning(
					`API request failed: ${response.status} ${response.statusText}\n${errorText}`,
				);
				await sleep(POLL_INTERVAL_MS);
				continue;
			}

			const result = (await response.json()) as DeploymentStatusResponse;

			// Check deployment status
			switch (result.status) {
				case "READY":
					// Deployment is ready!
					if (!result.deploymentURL) {
						throw new Error("Deployment is ready but no URL was provided");
					}
					return result;

				case "ERROR":
				case "CANCELED":
					// Deployment failed
					throw new Error(`Deployment failed with status: ${result.status}`);

				case "BUILDING":
				case "INITIALIZING":
				case "QUEUED":
					// Still in progress, continue polling
					core.info(`Deployment status: ${result.status}, waiting...`);
					await sleep(POLL_INTERVAL_MS);
					continue;

				default:
					core.warning(`Unknown deployment status: ${result.status}`);
					await sleep(POLL_INTERVAL_MS);
					continue;
			}
		} catch (error) {
			// If it's our own thrown error, re-throw it
			if (
				error instanceof Error &&
				error.message.startsWith("Deployment failed")
			) {
				throw error;
			}
			if (
				error instanceof Error &&
				error.message.startsWith("Authorization failed")
			) {
				throw error;
			}
			if (error instanceof Error && error.message.startsWith("Bad request")) {
				throw error;
			}

			// Network or other transient error - log and retry
			core.warning(
				`Error checking deployment status: ${error instanceof Error ? error.message : String(error)}`,
			);
			await sleep(POLL_INTERVAL_MS);
		}
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
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
