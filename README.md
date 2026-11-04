# OpenCRVS API for MOSIP

This repository provides an mediator/API layer that facilitates communication between OpenCRVS and MOSIP, enabling secure identity integration. Refer to [OpenCRVS documentation](https://documentation.opencrvs.org/technology/interoperability/national-id-client) for installation and deployment instructions.

## Prerequisites

- Node.js (see [`.nvmrc`](./.nvmrc) for version)
- Yarn (Node.js package manager)

## Development

```sh
# copy demo certs to gitignored location
cp docs/example-certs/* certs/

# install dependencies
yarn install

# create sqlite data directory
mkdir -p data/sqlite

# start the mosip-api and all the mocked servers
yarn dev

# optionally...
# use a `.env` file at repository root for custom config
touch .env
yarn dev

# only run the main server without mocks
yarn dev --filter=@opencrvs/mosip-api

# bump package.json versions
yarn set-version 1.7.0-alpha.16
```

This project uses a **SQLite** database to store the record-specific tokens that OpenCRVS Core uses to allow editing the records. See [`./packages/mosip-api/src/database.ts`](./packages/mosip-api/src/database.ts) for more information.

The **environment variables** the server uses can be found at [`./packages/mosip-api/src/constants.ts`](./packages/mosip-api/src/constants.ts). Create a `.env` file in the root of the repository, if you want to override the local values.

For the daily transaction report, map the deployment SMTP secret keys to these `mosip-api` environment variables:

| Deployment secret key | `mosip-api` environment variable      |
| --------------------- | ------------------------------------- |
| `smtp-host`           | `SMTP_HOST`                           |
| `smtp-port`           | `SMTP_PORT`                           |
| `smtp-username`       | `SMTP_USERNAME`                       |
| `smtp-secret`         | `SMTP_PASSWORD` (Google app password) |

`smtp-authkey` is not used. Configure `TRANSACTION_REPORT_RECIPIENTS` separately as a comma-separated list. For Gmail, use `smtp.gmail.com` on port `587` with STARTTLS (`SMTP_SECURE=false`); `SMTP_USERNAME` should be the Gmail/Google Workspace account, and `SMTP_PASSWORD` should be its Google app password. The sender must be that account or an authorized sender alias.

Set `MIDDLEWARE_BATCH_JOB=false` to disable scheduling the daily transaction report; it defaults to `true`.

The **identities** for E-Signet and IDA Auth mocks are found at [`./docs/mock-identities.json`](./docs/mock-identities.json).
