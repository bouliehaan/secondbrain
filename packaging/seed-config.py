#!/usr/bin/env python3
"""Print the example wall config with the weather pointed at this machine.

postinst runs this once, the first time the package is installed, to write
/opt/MagicMirror/config/config.js. After that the file is the owner's and
nothing in the package touches it again.

The location comes from the machine's own timezone: tzdata's zone1970.tab
records the coordinates of each zone's principal city, so a box set to
America/Denver gets Denver's weather with no lookup service, no network and
no question asked. That is the right city for most people and a near one for
everybody else; the README says how to change it. A machine on UTC, or one
whose zone has no coordinates, keeps the example's defaults.

Usage: seed-config.py <config.example.js>  >  config.js
"""

import os
import re
import sys

ZONE_TABLES = ("/usr/share/zoneinfo/zone1970.tab", "/usr/share/zoneinfo/zone.tab")


def system_timezone():
    """The IANA name the machine is set to, or None."""
    try:
        with open("/etc/timezone", encoding="utf-8") as handle:
            name = handle.read().strip()
            if name:
                return name
    except OSError:
        pass
    try:
        target = os.path.realpath("/etc/localtime")
    except OSError:
        return None
    marker = "/zoneinfo/"
    if marker in target:
        return target.split(marker, 1)[1]
    return None


def iso6709(value):
    """Convert zone.tab's +DDMM[SS]+DDDMM[SS] into (lat, lon) decimal degrees."""
    match = re.fullmatch(r"([+-])(\d{2})(\d{2})(\d{2})?([+-])(\d{3})(\d{2})(\d{2})?", value)
    if not match:
        return None
    lat_sign, lat_d, lat_m, lat_s, lon_sign, lon_d, lon_m, lon_s = match.groups()
    lat = int(lat_d) + int(lat_m) / 60 + int(lat_s or 0) / 3600
    lon = int(lon_d) + int(lon_m) / 60 + int(lon_s or 0) / 3600
    return (-lat if lat_sign == "-" else lat, -lon if lon_sign == "-" else lon)


def zone_location(zone):
    """(lat, lon, place) for a zone from tzdata, or None."""
    for table in ZONE_TABLES:
        try:
            with open(table, encoding="utf-8") as handle:
                for line in handle:
                    if line.startswith("#"):
                        continue
                    fields = line.rstrip("\n").split("\t")
                    if len(fields) >= 3 and fields[2] == zone:
                        coords = iso6709(fields[1])
                        if coords:
                            place = zone.rsplit("/", 1)[-1].replace("_", " ").upper()
                            return coords[0], coords[1], place
        except OSError:
            continue
    return None


def main():
    if len(sys.argv) != 2:
        sys.exit("usage: seed-config.py <config.example.js>")
    with open(sys.argv[1], encoding="utf-8") as handle:
        text = handle.read()

    zone = system_timezone()
    found = zone_location(zone) if zone else None
    if found:
        lat, lon, place = found
        text = re.sub(r"(lat: )[-0-9.]+(, // @lat)", lambda m: f"{m.group(1)}{lat:.4f}{m.group(2)}", text)
        text = re.sub(r"(lon: )[-0-9.]+(, // @lon)", lambda m: f"{m.group(1)}{lon:.4f}{m.group(2)}", text)
        text = re.sub(r'(header: )"[^"]*"(, // @place)', lambda m: f'{m.group(1)}"{place}"{m.group(2)}', text)
        print(f"secondbrain: weather set to {place.title()} from the {zone} timezone", file=sys.stderr)
    else:
        print("secondbrain: no location for this timezone; edit lat/lon in config.js", file=sys.stderr)
    sys.stdout.write(text)


if __name__ == "__main__":
    main()
