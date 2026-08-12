# BugFlow



BugFlow is a multi-organization bug-reporting and management workspace. It provides a dark, fast, original dashboard experience inspired by high-level product-workflow patterns, alongside a Railway-ready Node, React, and PostgreSQL application foundation.



## Product model



Each organization contains multiple **Projects**. A platform administrator creates organizations and their first organization administrators. Organization administrators manage their own users, projects, labels, and product-level access-control entries. Team members and administrators may participate in multiple organizations, while a customer account may belong to one organization only.



| Role | Scope | Core rights |

|---|---|---|

| Platform administrator | All organizations | Creates organizations, provisions initial organization admins, and has cross-organization oversight. |

| Organization administrator | One organization | Manages users, projects, project ACLs, issue workflow, restoration, and organization settings. |

| Team member | Explicitly granted projects | Views, comments, and manages reports only where project permissions allow. |

| Customer | One organization and explicitly granted projects | Views customer-visible reports, submits reports, comments, and soft-deletes only reports they submitted. |



## Included foundation



The first version includes a polished responsive dashboard and report workspace; issue filters; project navigation; a create-report interface; status, priority, due-date, label, assignment, duplicate, and internal-note data structures; user sessions; audit events; PostgreSQL migrations; project-scoped ACL records; and private attachment upload/download helpers. The backend additionally exposes foundations for signing in, creating organizations, creating organization users, creating projects, configuring project access, creating reports, posting comments, uploading attachments, updating status, and soft deletion/restoration.



| Deployment resource | Purpose | Required configuration |

|---|---|---|

| GitHub repository | Source of truth and release history | Connect `srinagubandi/bugflow` to the Railway service. |

| Railway application service | Builds and serves the React workspace plus Express API | Railway detects `railway.toml`, runs the build, migration, optional seed, and `npm run start`. |

| Railway PostgreSQL | Organizations, users, reports, comments, ACLs, notifications, and audit trail | Add a PostgreSQL service and reference its `DATABASE_URL`. |

| Railway Storage Bucket | Private report evidence and attachments | Add a bucket and reference its S3-compatible variables in the application service. |

| Resend | Customer-visible updates and password-reset delivery | Configure only after verifying a sending domain. |



Railway supports code-based deployment configuration, including a pre-deployment command that runs with service variables available, which this repository uses for the migration and optional initial-admin seed. [1](https://docs.railway.com/config-as-code/reference) [2](https://docs.railway.com/deployments/pre-deploy-command)



## Local development



Install Node 22 or newer, then install dependencies and start both the application server and Vite client:



```bash

pnpm install

pnpm dev

```



The development UI is available at `http://localhost:5173`; API requests proxy to `http://localhost:8080`. Copy `.env.example` to `.env` for local variables. Do not commit `.env` files or any credential value.



| Command | Purpose |

|---|---|

| `pnpm lint` | Runs strict TypeScript validation. |

| `pnpm build` | Builds the Vite client and bundled production server. |

| `pnpm db:migrate` | Applies the idempotent PostgreSQL schema migration. |

| `pnpm db:seed` | Creates the one-time platform admin only when all three `PLATFORM_ADMIN_*` variables are supplied. |

| `pnpm start` | Starts the production server on `PORT`, defaulting to `8080`. |



## Railway deployment



Create a Railway project named **bugflow**, then add an application service from the GitHub repository. Add a Railway PostgreSQL service and a private Railway Storage Bucket in the same project. Apply the variable references shown in `.env.example` to the application service, and configure `RESEND_API_KEY` and `RESEND_FROM_EMAIL` only after a sender domain is verified.



Railway Buckets use private, S3-compatible storage and can be connected to a service through variable references. BugFlow creates short-lived download URLs so evidence remains private. [3](https://docs.railway.com/storage-buckets)



The deployment will build the application, run `pnpm db:migrate`, optionally create the first platform administrator, and start the server. Use `PORT=8080`. After the first successful deployment, remove `PLATFORM_ADMIN_PASSWORD` from Railway variables and retain the admin account through the normal password reset flow.



## Git and release practice



The repository uses `main` for production-ready code. Develop changes on short-lived `feature/*` branches, open a pull request for review, merge into `main`, and tag a verified deployment with a semantic version such as `v0.1.0`. Railway can deploy from `main`; tags record a known-good rollback point wi
