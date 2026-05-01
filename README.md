# actions
GitHub Actions for interacting with Endform's platform

## `run-with-vercel-deployment`

Helps you to connect deployments associated with commits to an Endform test suite run.

This action requires that you both have the [Endform GitHub app](https://vercel.com/marketplace/endform) and the [Endform Vercel integration](https://vercel.com/marketplace/endform) installed.

The action:

- Finds the active deployment on Vercel associated with "this" commit.
- Waits for the deployment to be ready
- Exports the deployment URL to an environment variable
- Automatically configures Endform to bypass Vercel deployment protection when available

### Recommended usage

In most cases, you only need to provide the Vercel project name and the environment variable that should receive the deployment URL.

By default, the action requests a Vercel deployment protection bypass token and automatically passes it to Endform by [setting `ENDFORM_EXTRA_HTTP_HEADERS` with](https://endform.dev/docs/reference/endform-config#extrahttpheaders) the `x-vercel-protection-bypass` header. You do not need to export the bypass token yourself for Endform to use it.

For example:

```yml
name: Run end to end tests with endform

on:
  pull_request: # or push: if you want to run on commits to main
    branches:
      - main

permissions:
  contents: read
  id-token: write # required for authentication with Endform

jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Setup Node.js
        uses: actions/setup-node@v4
      
      - name: Set up pnpm
        uses: pnpm/action-setup@v4
        with:
          run_install: true

      - name: Wait for Vercel deployment
        uses: endformdev/actions/run-with-vercel-deployment@main
        with:
          project-name: endform-playwright-tutorial
          set-url-env-var: BASE_URL # Sets the Vercel preview URL as the BASE_URL environment variable

      - name: Run end to end tests with endform
        run: |
          npx endform@latest test
```

### Options

#### Vercel project

Use either `project-name` or `project-id` to tell the action which Vercel project to wait for. One of them is required.

`project-name` is usually the easiest option because it matches the project name you see in Vercel.

```yml
with:
  project-name: endform-playwright-tutorial
  set-url-env-var: BASE_URL
```

Use `project-id` if you prefer to identify the Vercel project by its stable ID instead of its name.

```yml
with:
  project-id: prj_abc123
  set-url-env-var: BASE_URL
```

#### Deployment URL environment variable

`set-url-env-var` is required. It chooses the environment variable name that receives the ready Vercel deployment URL.

For example, this makes the deployment URL available as `BASE_URL` to later workflow steps:

```yml
with:
  project-name: endform-playwright-tutorial
  set-url-env-var: BASE_URL
```

The action also exposes the same URL as the `deployment-url` action output.

#### Deployment protection bypass

`deployment-protection-bypass` controls whether the action asks Endform for a Vercel deployment protection bypass token. It defaults to `true`.

When a bypass token is returned, the action automatically sets `ENDFORM_EXTRA_HTTP_HEADERS` with the `x-vercel-protection-bypass` header. This is the recommended path for Endform tests against protected Vercel deployments.

Use `set-vercel-bypass-env-var` only if another tool or custom script also needs direct access to the raw bypass token. It is not required for Endform itself, and it is only exported when a bypass token is requested and returned.

```yml
with:
  project-name: endform-playwright-tutorial
  set-url-env-var: BASE_URL
  set-vercel-bypass-env-var: VERCEL_BYPASS_TOKEN
```

Set `deployment-protection-bypass: false` if you do not want the action to request or export a bypass token.

```yml
with:
  project-name: endform-playwright-tutorial
  set-url-env-var: BASE_URL
  deployment-protection-bypass: false
```

#### Timeout

`timeout-seconds` controls how long the action waits for the matching Vercel deployment to become ready. It defaults to `600` seconds, or 10 minutes.

```yml
with:
  project-name: endform-playwright-tutorial
  set-url-env-var: BASE_URL
  timeout-seconds: 900
```

### Outputs

The action sets these outputs for later workflow steps:

- `deployment-url`: the ready Vercel deployment URL
- `deployment-id`: the Vercel deployment ID returned by Endform
- `message`: a status message, currently `Deployment ready`
