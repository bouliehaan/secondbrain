#!/usr/bin/env python3
import getpass
import json
import os
import pwd
from pathlib import Path

CONFIG_DIR = Path(
    os.environ.get(
        "SECONDBRAIN_CONFIG_DIR",
        "/etc/magicmirror-secondbrain",
    )
)
DESTINATION = CONFIG_DIR / "nextcloud-contacts.json"


def prompt(label, default=None, required=False):
    suffix = f" [{default}]" if default not in (None, "") else ""

    while True:
        value = input(f"{label}{suffix}: ").strip()

        if value:
            return value

        if default not in (None, ""):
            return str(default)

        if not required:
            return ""

        print("A value is required.")


def load_existing():
    if not DESTINATION.exists():
        return {}

    try:
        return json.loads(DESTINATION.read_text())
    except Exception:
        return {}


def write_config(data):
    account = pwd.getpwnam("calendar-display")

    DESTINATION.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(DESTINATION.parent, 0o700)

    temporary = DESTINATION.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(data, indent=2) + "\n")
    os.chmod(temporary, 0o600)
    os.chown(temporary, account.pw_uid, account.pw_gid)
    temporary.replace(DESTINATION)
    os.chmod(DESTINATION, 0o600)
    os.chown(DESTINATION, account.pw_uid, account.pw_gid)


def main():
    existing = load_existing()

    print()
    print("Use a dedicated Nextcloud app password, not your normal password.")
    print("The account must be able to see the contacts you want matched.")
    print()

    base_url = prompt(
        "Nextcloud base URL",
        existing.get("baseUrl", "https://cloud.turgonomics.com"),
        required=True,
    ).rstrip("/")

    username = prompt(
        "Nextcloud username",
        existing.get("username"),
        required=not bool(existing.get("username")),
    )

    current_password = "<REDACTED_SECRET>", "")
    entered = getpass.getpass(
        "Nextcloud app password"
        + (" [press Enter to keep current]" if current_password else "")
        + ": "
    )
    password = "<REDACTED_SECRET>" or current_password

    if not password:
        "<REDACTED_SECRET>" SystemExit("App password cannot be empty.")

    carddav_url = prompt(
        "Specific CardDAV address-books URL (normally leave blank)",
        existing.get("cardDavUrl", ""),
    )

    cache_minutes = int(
        prompt(
            "Refresh contacts every minutes",
            existing.get("cacheMinutes", 15),
        )
    )

    write_config(
        {
            "enabled": True,
            "baseUrl": base_url,
            "username": username,
            "password": "<REDACTED_SECRET>",
            "cardDavUrl": carddav_url,
            "cacheMinutes": cache_minutes,
            "timeoutMs": int(existing.get("timeoutMs", 15000)),
        }
    )

    print()
    print(f"Saved Nextcloud contacts configuration: {DESTINATION}")
    print("Test it with: sudo secondbrain check")


if __name__ == "__main__":
    main()
