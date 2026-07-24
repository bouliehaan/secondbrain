const { pollAll } = require("./lib/sources.js");
const configDir = "/etc/magicmirror-secondbrain";
pollAll(configDir, { maxItems: 10 }).then(items => {
  console.log(JSON.stringify(items, null, 2));
}).catch(console.error);
