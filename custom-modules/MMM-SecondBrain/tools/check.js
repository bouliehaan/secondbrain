#!/usr/bin/env node
"use strict";

const { pollAll } = require("../lib/sources");

const configDir = process.env.SECONDBRAIN_CONFIG_DIR || "/etc/magicmirror-secondbrain";

(async () => {
  const items = await pollAll(configDir, { maxItems: 20 }, console);
  console.log(JSON.stringify({ count: items.length, items }, null, 2));
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
