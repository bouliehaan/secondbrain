PKG := secondbrain
MM_MODULE := modules/MMM-SecondBrain

.PHONY: check check-all syntax deps deb lint clean help

## help: list the targets
help:
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/^## /  /'

## syntax: every shipped script parses. A syntax error here is a blank wall.
syntax:
	@set -e; \
	find modules config -name '*.js' -not -path '*/node_modules/*' \
	    -exec node --check {} \; >/dev/null
	@bash -n system/bin/calendar-kiosk
	@sh -n packaging/bin/secondbrain-server
	@sh -n packaging/debian/postinst
	@sh -n packaging/debian/prerm
	@sh -n packaging/debian/postrm
	@python3 -m py_compile packaging/seed-config.py
	@bash -n packaging/build-deb.sh
	@bash -n packaging/smoke-install.sh
	@python3 -m py_compile clock/magicmirror-python-clock.py
	@echo "  all shipped scripts parse"

## deps: install what the checks import (mailparser, imapflow)
deps: $(MM_MODULE)/node_modules

# The checks import the module's own lib/, which imports mailparser and
# imapflow. node_modules is gitignored, so a fresh clone -- CI, or a new laptop
# -- has none and check-packages dies on MODULE_NOT_FOUND. This passed locally
# only because an install happened to be sitting there already; a gate that
# depends on that is not a gate.
$(MM_MODULE)/node_modules: $(MM_MODULE)/package-lock.json
	@cd $(MM_MODULE) && npm ci --omit=dev --no-audit --no-fund
	@touch $@

## check: everything CI runs. Needs no mirror, no account and no credentials.
check: deps syntax
	@node scripts/check-packages.js     >/dev/null && echo "  packages     ok"
	@node scripts/check-mail.js         >/dev/null && echo "  mail         ok"
	@node scripts/check-nowplaying.js   >/dev/null && echo "  nowplaying   ok"
	@node scripts/check-freeze-watch.js >/dev/null && echo "  freeze-watch ok"
	@node scripts/check-solar-theme.js  >/dev/null && echo "  solar-theme  ok"
	@node scripts/check-status-line.js  >/dev/null && echo "  status-line  ok"
	@node scripts/check-rail.js         >/dev/null && echo "  rail         ok"
	@node scripts/check-example-config.js >/dev/null && echo "  example      ok"

## check-all: check, plus the slow one (~30s; it waits out a real deadline)
check-all: check
	@node scripts/check-poll-resilience.js >/dev/null && echo "  poll         ok"

## deb: build dist/secondbrain_<arch>.deb for amd64, arm64 and armhf. VERSION=1.3.0 make deb; ARCHES=amd64 for one.
deb:
	packaging/build-deb.sh

## lint: what CI checks about the built package
lint: deb
	@for deb in dist/$(PKG)_*.deb; do dpkg-deb --info $$deb; dpkg-deb --contents $$deb; done

clean:
	rm -rf build dist
	find . -name __pycache__ -prune -exec rm -rf {} + 2>/dev/null || true
