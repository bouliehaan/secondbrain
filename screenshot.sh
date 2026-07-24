#!/usr/bin/env bash
set -e

REMOTE="jake@192.168.1.10"

echo "Taking screenshot of MagicMirror display..."
ssh -t $REMOTE "sudo rm -f /tmp/magicmirror-screenshot.png && sudo -u calendar-display DISPLAY=:0 XAUTHORITY=/home/calendar-display/.Xauthority scrot /tmp/magicmirror-screenshot.png"

echo "Downloading screenshot..."
mkdir -p screenshot
rsync -avz $REMOTE:/tmp/magicmirror-screenshot.png screenshot/current-display.png

echo "Screenshot saved to screenshot/current-display.png"
