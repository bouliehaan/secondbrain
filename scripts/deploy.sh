#!/usr/bin/env bash
set -e

REMOTE="jake@192.168.1.10"

echo "Deploying SecondBrain & Python Clock to MagicMirror ($REMOTE)..."

echo "=> Creating temporary deployment directory..."
ssh $REMOTE "mkdir -p /tmp/magicmirror_deploy"

echo "=> Transferring files..."
rsync -avz custom-modules/MMM-SecondBrain/MMM-SecondBrain.js $REMOTE:/tmp/magicmirror_deploy/
rsync -avz custom-modules/MMM-SecondBrain/node_helper.js $REMOTE:/tmp/magicmirror_deploy/sb_node_helper.js
rsync -avz custom-modules/MMM-SolarTheme/MMM-SolarTheme.js $REMOTE:/tmp/magicmirror_deploy/
rsync -avz custom-modules/MMM-SolarTheme/node_helper.js $REMOTE:/tmp/magicmirror_deploy/
rsync -avz clock-renderers/magicmirror-python-clock.py $REMOTE:/tmp/magicmirror_deploy/
rsync -avz openbox-lightdm/openbox-autostart $REMOTE:/tmp/magicmirror_deploy/
rsync -avz configuration/patch_config.js $REMOTE:/tmp/magicmirror_deploy/

echo "=> Moving files to final locations and applying permissions (you may be asked for your sudo password)..."
ssh -t $REMOTE "
# 1. Update MMM-SolarTheme
sudo mv /tmp/magicmirror_deploy/MMM-SolarTheme.js /opt/MagicMirror/modules/MMM-SolarTheme/
sudo mv /tmp/magicmirror_deploy/node_helper.js /opt/MagicMirror/modules/MMM-SolarTheme/
sudo chown root:root /opt/MagicMirror/modules/MMM-SolarTheme/MMM-SolarTheme.js /opt/MagicMirror/modules/MMM-SolarTheme/node_helper.js

# 2. Update SecondBrain
sudo mv /tmp/magicmirror_deploy/MMM-SecondBrain.js /opt/MagicMirror/modules/MMM-SecondBrain/
sudo mv /tmp/magicmirror_deploy/sb_node_helper.js /opt/MagicMirror/modules/MMM-SecondBrain/node_helper.js
sudo chown -R root:root /opt/MagicMirror/modules/MMM-SecondBrain
sudo chmod -R 755 /opt/MagicMirror/modules/MMM-SecondBrain

# 3. Safely update intervals in remote config
sudo sed -i 's/fetchInterval: [0-9]*/fetchInterval: 15000/g' /opt/MagicMirror/config/config.js
sudo sed -i 's/refreshInterval: [0-9]*/refreshInterval: 15000/g' /opt/MagicMirror/config/config.js
sudo sed -i 's/pollIntervalMs: [0-9]*/pollIntervalMs: 3000/g' /opt/MagicMirror/config/config.js

# 3b. Hide past events in upcoming agenda
sudo node /tmp/magicmirror_deploy/patch_config.js

# 4. Update Clock
sudo mv /tmp/magicmirror_deploy/magicmirror-python-clock.py /usr/local/bin/
sudo chown root:root /usr/local/bin/magicmirror-python-clock.py
sudo chmod +x /usr/local/bin/magicmirror-python-clock.py

# 4. Update Autostart
sudo mkdir -p /home/calendar-display/.config/openbox
sudo mv /tmp/magicmirror_deploy/openbox-autostart /home/calendar-display/.config/openbox/autostart
sudo chown calendar-display:calendar-display /home/calendar-display/.config/openbox/autostart
sudo chmod +x /home/calendar-display/.config/openbox/autostart

# Cleanup
sudo rm -rf /tmp/magicmirror_deploy

# Restart services
echo '=> Restarting services to apply changes...'
sudo systemctl restart magicmirror
sudo systemctl restart lightdm
"

echo "Deployment complete."
