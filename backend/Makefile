# Database Migration Commands
# ===========================
# Run `make help` to see all available commands.

.PHONY: help migrate migrate-check migrate-new migrate-up migrate-down migrate-history migrate-current migrate-stamp

PYTHON = python
ALEMBIC = alembic

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

# --- Migration Commands ---

migrate-check: ## Check for pending migrations or model drift (run in CI)
	$(PYTHON) check_migrations.py --diff

migrate-new: ## Create a new migration (usage: make migrate-new MSG="add user avatar")
	$(ALEMBIC) revision --autogenerate -m "$(MSG)"

migrate-up: ## Apply all pending migrations
	$(ALEMBIC) upgrade head

migrate-down: ## Rollback last migration (usage: make migrate-down REVISION=b2c3d4e5f6a7)
	$(ALEMBIC) downgrade $(REVISION)

migrate-history: ## Show migration history
	$(ALEMBIC) history

migrate-current: ## Show current database revision
	$(ALEMBIC) current

migrate-stamp: ## Mark a revision as current without running it (usage: make migrate-stamp REVISION=head)
	$(ALEMBIC) stamp $(REVISION)

# --- Development Shortcuts ---

migrate-add-users-avatar: ## Example: add a column to users table
	$(ALEMBIC) revision --autogenerate -m "add avatar_url to users"

migrate-new-manual: ## Create an empty migration for manual SQL
	$(ALEMBIC) revision -m "$(MSG)"
