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

interface TokenWithExpiry {
	token: string;
	expiresAt: number; // Unix timestamp in milliseconds
}

type PollResult =
	| { type: "success"; data: DeploymentStatusResponse }
	| { type: "continue"; reason: string }
	| { type: "fatal"; error: string };

const IN_PROGRESS_STATUSES = ["BUILDING", "INITIALIZING", "QUEUED"] as const;
const FAILED_STATUSES = ["ERROR", "CANCELED"] as const;

async function run() {
	try {
		const projectName = core.getInput("project-name");
		const projectId = core.getInput("project-id");
		const setUrlEnvVar = core.getInput("set-url-env-var", { required: true });
		const timeoutSeconds = Number.parseInt(
			core.getInput("timeout-seconds") || String(DEFAULT_TIMEOUT_SECONDS),
			10,
		);
		// Allow overriding Endform URL via environment variable (for testing)
		const endformUrl = process.env.ENDFORM_URL || DEFAULT_ENDFORM_URL;

		const tokenWithExpiry = await createTokenWithExpiry();
		core.info("Successfully obtained OIDC token");

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

		const jobName = process.env.GITHUB_JOB;
		if (!jobName) {
			throw new Error("GITHUB_JOB environment variable is not set");
		}

		core.info(`Waiting for Vercel deployment (${projectName || projectId})...`);
		core.info(`Timeout: ${timeoutSeconds} seconds`);
		if (endformUrl !== DEFAULT_ENDFORM_URL) {
			core.info(`Using custom Endform URL: ${endformUrl}`);
		}

		const result = await waitForVercelDeployment(
			tokenWithExpiry,
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
	initialToken: TokenWithExpiry,
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
	let currentToken = initialToken;

	while (true) {
		// Check if we've exceeded the timeout
		if (Date.now() - startTime > timeoutMs) {
			throw new Error(
				`Timeout waiting for deployment after ${timeoutSeconds} seconds`,
			);
		}

		currentToken = await getValidToken(currentToken);
		const result = await pollDeploymentStatus(
			apiUrl,
			currentToken.token,
			sha,
			jobName,
			projectName,
			projectId,
		);

		switch (result.type) {
			case "success":
				return result.data;

			case "fatal":
				throw new Error(result.error);

			case "continue":
				core.info(result.reason);
				await sleep(POLL_INTERVAL_MS);
				break;
		}
	}
}

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

		if (response.status === 409) {
			const errorText = await response.text();
			return {
				type: "fatal",
				error: `Conflict when fetching deployment status: ${response.status} ${response.statusText}\n${errorText}`,
			};
		}

		if (response.status === 404) {
			await response.text();
			return {
				type: "continue",
				reason: "Deployment not found yet, waiting for it to be created",
			};
		}

		// if the response is 5xx, it's a fatal error
		if (response.status >= 500 && response.status < 600) {
			const errorText = await response.text();
			return {
				type: "fatal",
				error: `Server error: ${response.status} ${response.statusText}\n${errorText}`,
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

		const result = (await response.json()) as DeploymentStatusResponse;

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

async function createTokenWithExpiry(): Promise<TokenWithExpiry> {
	const token = await getOIDCToken();
	const expiresAt = getTokenExpiry(token);

	core.debug(`Token expires at: ${new Date(expiresAt).toISOString()}`);

	return { token, expiresAt };
}

async function getValidToken(
	currentToken: TokenWithExpiry,
): Promise<TokenWithExpiry> {
	if (shouldRefreshToken(currentToken)) {
		core.info("OIDC token approaching expiry, refreshing...");
		return await createTokenWithExpiry();
	}

	return currentToken;
}

async function getOIDCToken(): Promise<string> {
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

/**
 * Decodes a JWT token and extracts the expiry claim (exp).
 * Returns the expiry timestamp in milliseconds.
 */
function getTokenExpiry(token: string): number {
	try {
		// JWT format: header.payload.signature
		const parts = token.split(".");
		if (parts.length !== 3) {
			throw new Error("Invalid JWT format");
		}

		// Decode the payload (base64url encoded)
		const payload = JSON.parse(
			Buffer.from(parts[1], "base64url").toString("utf8"),
		);

		if (!payload.exp || typeof payload.exp !== "number") {
			throw new Error("Token does not contain valid exp claim");
		}

		// Convert from seconds to milliseconds
		return payload.exp * 1000;
	} catch (error) {
		throw new Error(
			`Failed to decode token expiry: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function shouldRefreshToken(tokenWithExpiry: TokenWithExpiry): boolean {
	const REFRESH_BUFFER_MS = 30 * 1000; // 30 seconds before expiry
	const timeUntilExpiry = tokenWithExpiry.expiresAt - Date.now();

	return timeUntilExpiry <= REFRESH_BUFFER_MS;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

run();
