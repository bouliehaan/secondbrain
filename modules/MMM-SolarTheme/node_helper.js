const NodeHelper = require("node_helper");
const fs = require("fs");
const path = require("path");

module.exports = NodeHelper.create({
  socketNotificationReceived: function (notification, payload) {
    if (notification === "THEME_CHANGED") {
      const isLight = payload === "light";
      const colorHex = isLight ? "#000000" : "#FFFFFF";
      const colorOutput = `\${color ${colorHex}}`;
      
      const filePath = "/tmp/magicmirror-clock-color";
      
      fs.writeFile(filePath, colorOutput, (err) => {
        if (err) {
          console.error("[MMM-SolarTheme] Error writing clock color to " + filePath, err);
        }
      });
    }
  }
});
