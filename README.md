# actions
Github Actions for interacting with Endform's platform

## `run-with-vercel-deployment`

Helps you to connect deployments associated with commits to an Endform test suite run.

This action requires that you both have the Endform Github app and the Endform Vercel integration installed.

The action:

- Finds the active deployment on vercel associated with "this" commit.
- Waits for the deployment to be ready
- Exports the url and (optionally) deployment protection bypass token to environment variables

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
          set-vercel-bypass-env-var: VERCEL_BYPASS_TOKEN # Exports a deployment protection bypass token as this env var

      - name: Run end to end tests with endform
        run: |
          npx endform@latest test
```
