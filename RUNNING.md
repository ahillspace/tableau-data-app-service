# Local development

Use Node 26.13 or later in the Node 26 LTS line and npm.
`npm ci` installs the checked-in dependency graph, including a project-local LTS executable and Linux x64 Postgres test binaries.
The test database is a real isolated loopback process in a temporary directory and needs neither Docker nor a shared database service.
The binary package is a development dependency, never a production database provisioner.

Run `npm run typecheck`, `npm run lint`, `npm run build` and `npm test`.
Tests clean up their own Postgres processes and directories.
Use a disposable database for any manually configured test run.

Copy `.env.example` to a protected environment file and replace the database credentials, HTTPS service origin and encryption key material.
Generate a fresh 32-byte key with `openssl rand -hex 32` and provide it through protected environment custody.
Never commit keys or populated environment files.
Budget `DB_POOL_MAX` and `DB_CONTROL_POOL_MAX` across all replicas, workers, migration commands and deployment overlap before running them together.

Load that environment before running `npm run db:migrate` through the separately authorized migration role.
API and worker processes never migrate on startup.
`npm start` currently exposes liveness and database/schema readiness only; the application modules are under active implementation.
This foundation does not claim Tableau authentication, provider proxy, Jobs or event behavior.
No public deployment is selected or authorized.
