.PHONY: install build test test-focused smoke \
        mcp-add mcp-remove mcp-list \
        auggie-add auggie-remove auggie-list \
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

clean:
	rm -rf dist node_modules
