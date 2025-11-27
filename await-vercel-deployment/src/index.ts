import { readFileSync } from "node:fs";
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

/**
 * Represents the result of a single poll attempt.
 * Using a discriminated union to make control flow explicit.
 */
type PollResult =
	| { type: "success"; data: DeploymentStatusResponse }
	| { type: "continue"; reason: string }
	| { type: "fatal"; error: string };

/**
 * Deployment statuses that indicate the deployment is still in progress
 */
const IN_PROGRESS_STATUSES = ["BUILDING", "INITIALIZING", "QUEUED"] as const;

/**
 * Deployment statuses that indicate a terminal failure state
 */
const FAILED_STATUSES = ["ERROR", "CANCELED"] as const;

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
		// For pull_request events, use the head SHA instead of the merge commit SHA
		let sha = process.env.GITHUB_SHA;
		const eventName = process.env.GITHUB_EVENT_NAME;

		if (eventName === "pull_request" || eventName === "pull_request_target") {
			try {
				const eventPath = process.env.GITHUB_EVENT_PATH;
				if (eventPath) {
					const eventData = JSON.parse(readFileSync(eventPath, "utf8"));
					if (eventData.pull_request?.head?.sha) {
						sha = eventData.pull_request.head.sha;
						core.info(`Using PR head SHA: ${sha} (instead of merge commit)`);
					}
				}
			} catch (error) {
				core.warning(
					`Failed to get PR head SHA, falling back to GITHUB_SHA: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}

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

/**
 * Performs a single poll attempt to check deployment status.
 * Returns a discriminated union that explicitly indicates whether to:
 * - Return successfully (type: "success")
 * - Continue polling (type: "continue")
 * - Fail fatally (type: "fatal")
 */
async function pollDeploymentStatus(
	apiUrl: string,
	token: string,
	sha: string,
	jobName: string,
	projectName: string | null,
	projectId: string | null,
): Promise<PollResult> {
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

		// Handle HTTP error responses
		// 400/403 are fatal - they indicate configuration or auth issues
		// 404 means deployment not found yet, so continue polling
		if (response.status === 400) {
			const errorText = await response.text();
			return {
				type: "fatal",
				error: `Bad request: ${response.status} ${response.statusText}\n${errorText}`,
			};
		}

		if (response.status === 403) {
			const errorText = await response.text();
			return {
				type: "fatal",
				error: `Authorization failed: ${response.status} ${response.statusText}\n${errorText}`,
			};
		}

		if (response.status === 404) {
			// Deployment not created yet - continue polling
			await response.text(); // Consume response body
			return {
				type: "continue",
				reason: "Deployment not found yet, waiting for it to be created",
			};
		}

		// Other HTTP errors are transient - continue polling
		if (!response.ok) {
			const errorText = await response.text();
			return {
				type: "continue",
				reason: `API request failed: ${response.status} ${response.statusText}\n${errorText}`,
			};
		}

		// Parse successful response
		const result = (await response.json()) as DeploymentStatusResponse;

		// Handle deployment status
		if (result.status === "READY") {
			if (!result.deploymentURL) {
				return {
					type: "fatal",
					error: "Deployment is ready but no URL was provided",
				};
			}
			return { type: "success", data: result };
		}

		if (
			FAILED_STATUSES.includes(
				result.status as (typeof FAILED_STATUSES)[number],
			)
		) {
			return {
				type: "fatal",
				error: `Deployment failed with status: ${result.status}`,
			};
		}

		if (
			IN_PROGRESS_STATUSES.includes(
				result.status as (typeof IN_PROGRESS_STATUSES)[number],
			)
		) {
			return {
				type: "continue",
				reason: `Deployment status: ${result.status}`,
			};
		}

		// Unknown status - treat as in-progress and continue
		return {
			type: "continue",
			reason: `Unknown deployment status: ${result.status}`,
		};
	} catch (error) {
		// Network errors and other exceptions are transient - continue polling
		const errorMessage = error instanceof Error ? error.message : String(error);
		return {
			type: "continue",
			reason: `Error checking deployment status: ${errorMessage}`,
		};
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

		const result = await pollDeploymentStatus(
			apiUrl,
			token,
			sha,
			jobName,
			projectName,
			projectId,
		);

		// Handle result based on its type
		switch (result.type) {
			case "success":
				// We're done!
				return result.data;

			case "fatal":
				// Non-recoverable error - throw immediately
				throw new Error(result.error);

			case "continue":
				// Log the reason and continue polling
				core.info(result.reason);
				await sleep(POLL_INTERVAL_MS);
				break;
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
