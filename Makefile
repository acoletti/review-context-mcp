.PHONY: install build test test-focused smoke \
        mcp-add mcp-remove mcp-list \
        auggie-add auggie-remove auggie-list \
        hermes-add hermes-remove \
        clean

install:
	./scripts/install_local.sh

build:
	npm run build

test:
	npm test

test-focused:
	npm run test:focused

smoke:
	npm run test:smoke

mcp-add:
	./scripts/mcp_add.sh

mcp-remove:
	./scripts/mcp_remove.sh

mcp-list:
	claude mcp list

auggie-add:
	./scripts/auggie_add.sh

auggie-remove:
	./scripts/auggie_remove.sh

auggie-list:
	auggie mcp list

## Hermes Agent registration. Hermes has no `mcp add` CLI, so this edits
## ~/.hermes/config.yaml directly (backed up, atomic, verified). Skips
## cleanly when Hermes is absent. Restart Hermes to pick up the change.
hermes-add:
	./scripts/hermes_add.sh

hermes-remove:
	./scripts/hermes_add.sh --remove

clean:
	rm -rf dist node_modules
