PKG := secondbrain

.PHONY: check check-all syntax deb lint clean help

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
	@bash -n packaging/build-deb.sh
	@python3 -m py_compile clock/magicmirror-python-clock.py
	@echo "  all shipped scripts parse"

## check: everything CI runs. Needs no mirror, no account and no credentials.
check: syntax
	@node scripts/check-packages.js     >/dev/null && echo "  packages     ok"
	@node scripts/check-nowplaying.js   >/dev/null && echo "  nowplaying   ok"
	@node scripts/check-freeze-watch.js >/dev/null && echo "  freeze-watch ok"

## check-all: check, plus the slow one (~30s; it waits out a real deadline)
check-all: check
	@node scripts/check-poll-resilience.js >/dev/null && echo "  poll         ok"

## deb: build dist/secondbrain_all.deb. VERSION=1.3.0 make deb to set the version.
deb:
	packaging/build-deb.sh

## lint: what CI checks about the built package
lint: deb
	@dpkg-deb --info dist/$(PKG)_all.deb
	@dpkg-deb --contents dist/$(PKG)_all.deb

clean:
	rm -rf build dist
	find . -name __pycache__ -prune -exec rm -rf {} + 2>/dev/null || true
