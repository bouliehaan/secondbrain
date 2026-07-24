#!/usr/bin/env python3
import argparse
import getpass
import json
import os
import re
from pathlib import Path

CONFIG_DIR = Path(os.environ.get("SECONDBRAIN_CONFIG_DIR", "/etc/magicmirror-secondbrain"))
OWNER_UID = None
OWNER_GID = None


def resolve_owner():
    global OWNER_UID, OWNER_GID
    import pwd

    account = pwd.getpwnam("calendar-display")
    OWNER_UID = account.pw_uid
    OWNER_GID = account.pw_gid


def ensure_dir(path: Path):
    path.mkdir(parents=True, exist_ok=True)
    os.chmod(path, 0o700)
    os.chown(path, OWNER_UID, OWNER_GID)


def write_json(path: Path, data):
    ensure_dir(path.parent)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(data, indent=2) + "\n")
    os.chmod(temporary, 0o600)
    os.chown(temporary, OWNER_UID, OWNER_GID)
    temporary.replace(path)
    os.chmod(path, 0o600)
    os.chown(path, OWNER_UID, OWNER_GID)


def prompt(label, default=None, required=False):
    suffix = f" [{default}]" if default is not None else ""
    while True:
        value = input(f"{label}{suffix}: ").strip()
        if value:
            return value
        if default is not None:
            return str(default)
        if not required:
            return ""
        print("A value is required.")


def alias_value(raw):
    value = raw.strip().lower()
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,31}", value):
        raise SystemExit(
            "Alias must use only letters, numbers, hyphens, or underscores."
        )
    return value


def load_existing(path: Path):
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text())
    except Exception:
        return {}


def gmail(alias):
    alias = alias_value(alias)
    destination = CONFIG_DIR / "gmail" / "accounts" / f"{alias}.json"
    existing = load_existing(destination)

    print("\nUse a Google App Password, not your normal Google password.")
    print("Spaces in Google's 16-character App Password are removed automatically.\n")

    email = prompt(
        "Full Gmail address",
        existing.get("email"),
        required=not bool(existing.get("email")),
    ).lower()

    if "@" not in email:
        raise SystemExit("That does not look like a complete email address.")

    display_name = prompt(
        "Display name",
        existing.get("displayName", email),
    )

    current_password = "<REDACTED_SECRET>", "")
    entered = getpass.getpass(
        "Google App Password"
        + (" [press Enter to keep current]" if current_password else "")
        + ": "
    )
    password = "<REDACTED_SECRET>" or current_password).replace(" ", "")

    if not password:
        "<REDACTED_SECRET>" SystemExit("App Password cannot be empty.")

    important_mailbox = prompt(
        "Important-mail Gmail label",
        existing.get("importantMailbox", "Wall-Display"),
    )
    monitor_voice = prompt(
        "Monitor Google Voice emails? yes/no",
        "yes" if existing.get("monitorVoice", True) else "no",
    ).lower() in {"y", "yes", "true", "1"}
    voice_minutes = int(
        prompt(
            "Keep new Google Voice notifications for minutes",
            existing.get("voiceMaxAgeMinutes", 60),
        )
    )

    data = {
        "enabled": True,
        "alias": alias,
        "displayName": display_name,
        "email": email,
        "host": "imap.gmail.com",
        "port": 993,
        "secure": True,
        "rejectUnauthorized": True,
        "username": email,
        "password": "<REDACTED_SECRET>",
        "importantMailbox": important_mailbox,
        "maxAgeDays": int(existing.get("maxAgeDays", 14)),
        "maxResults": int(existing.get("maxResults", 8)),
        "monitorVoice": monitor_voice,
        "voiceMailbox": existing.get("voiceMailbox", "INBOX"),
        "voiceMaxAgeMinutes": voice_minutes,
        "voiceMaxResults": int(existing.get("voiceMaxResults", 20)),
    }

    write_json(destination, data)
    print(f"Saved Gmail IMAP account: {destination}")
    print("Test it with: sudo secondbrain check")


def proton(alias):
    alias = alias_value(alias)
    destination = CONFIG_DIR / "proton" / "accounts" / f"{alias}.json"
    existing = load_existing(destination)

    print("\nUse the IMAP username and generated IMAP password shown by Proton Mail Bridge.")
    print("Do not enter your normal Proton account password here.\n")

    display_name = prompt("Display name", existing.get("displayName", alias))
    host = prompt("Bridge IMAP host", existing.get("host", "127.0.0.1"))
    port = int(prompt("Bridge IMAP port", existing.get("port", 1143)))
    username = prompt(
        "Bridge IMAP username",
        existing.get("username"),
        required=not bool(existing.get("username")),
    )
    current_password = "<REDACTED_SECRET>", "")
    entered = getpass.getpass(
        "Bridge-generated IMAP password"
        + (" [press Enter to keep current]" if current_password else "")
        + ": "
    )
    password = "<REDACTED_SECRET>" or current_password
    if not password:
        "<REDACTED_SECRET>" SystemExit("Password cannot be empty.")
    mailbox = prompt(
        "Important-mail mailbox",
        existing.get("mailbox", "Labels/Wall Display"),
    )

    data = {
        "enabled": True,
        "alias": alias,
        "displayName": display_name,
        "host": host,
        "port": port,
        "secure": False,
        "rejectUnauthorized": False,
        "username": username,
        "password": "<REDACTED_SECRET>",
        "mailbox": mailbox,
        "maxAgeDays": int(existing.get("maxAgeDays", 14)),
        "maxResults": int(existing.get("maxResults", 8)),
    }

    write_json(destination, data)
    print(f"Saved Proton Bridge account: {destination}")


def transmission():
    destination = CONFIG_DIR / "transmission.json"
    existing = load_existing(destination)

    url = prompt(
        "Transmission RPC URL",
        existing.get("url", "http://127.0.0.1:9091/transmission/rpc"),
    )
    username = prompt("Transmission RPC username", existing.get("username", ""))
    password = "<REDACTED_SECRET>"
    if username:
        current = existing.get("password", "")
        entered = getpass.getpass(
            "Transmission RPC password"
            + (" [press Enter to keep current]" if current else "")
            + ": "
        )
        password = "<REDACTED_SECRET>" or current
    completed = int(
        prompt(
            "Show completed downloads for minutes",
            existing.get("recentCompletedMinutes", 45),
        )
    )

    data = {
        "enabled": True,
        "url": url,
        "username": username,
        "password": "<REDACTED_SECRET>",
        "recentCompletedMinutes": completed,
    }
    write_json(destination, data)
    print(f"Saved Transmission configuration: {destination}")


def status():
    print(f"Configuration directory: {CONFIG_DIR}")

    gmail_dir = CONFIG_DIR / "gmail" / "accounts"
    proton_dir = CONFIG_DIR / "proton" / "accounts"

    gmail_accounts = (
        sorted(path.stem for path in gmail_dir.glob("*.json"))
        if gmail_dir.exists()
        else []
    )
    proton_accounts = (
        sorted(path.stem for path in proton_dir.glob("*.json"))
        if proton_dir.exists()
        else []
    )

    print(
        "Gmail IMAP accounts:",
        ", ".join(gmail_accounts) if gmail_accounts else "none",
    )
    print(
        "Proton accounts:",
        ", ".join(proton_accounts) if proton_accounts else "none",
    )
    print(
        "Transmission:",
        "configured"
        if (CONFIG_DIR / "transmission.json").exists()
        else "not configured",
    )


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)

    gmail_parser = sub.add_parser("gmail")
    gmail_parser.add_argument("alias")

    proton_parser = sub.add_parser("proton")
    proton_parser.add_argument("alias")

    sub.add_parser("transmission")
    sub.add_parser("status")

    args = parser.parse_args()
    resolve_owner()
    ensure_dir(CONFIG_DIR)

    if args.command == "gmail":
        gmail(args.alias)
    elif args.command == "proton":
        proton(args.alias)
    elif args.command == "transmission":
        transmission()
    elif args.command == "status":
        status()


if __name__ == "__main__":
    main()
