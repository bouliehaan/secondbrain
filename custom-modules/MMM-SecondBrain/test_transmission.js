const { pollTransmission } = require("./lib/sources.js");
const configDir = "/etc/magicmirror-secondbrain";
pollTransmission(configDir).then(console.log).catch(console.error);
