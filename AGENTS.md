# Application development

- Keep changes small. The pull request checks are the test and run what the change needs, so do not run tests locally; only when a check fails, run the failing test. Apply the formatters before pushing. Describe the change, tests and verification limits clearly.
- Study is read-only and imports neither Maintenance nor preparation. Maintenance and preparation do not import Study. Shared imports no application. Keep domain logic in its owning service.
- Keep Data declarative in `schemas/` with one D1 migration sequence. Keep generated indexes outside Git.
- Use synthetic fixtures. Never commit credentials or restricted source material. Software licensing does not grant source redistribution rights.
- Public pull-request checks must remain unprivileged. Deployment, provisioning, acquisition and data promotion use separate authorized paths.
