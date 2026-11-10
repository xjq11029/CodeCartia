require("node:fs").writeFileSync(require("node:path").join(__dirname, "sentinel.executed"), "fixture executed");
throw new Error("Only parse this fixture; never execute it");
