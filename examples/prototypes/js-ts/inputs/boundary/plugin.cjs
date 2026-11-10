require("node:fs").writeFileSync(require("node:path").join(__dirname, "plugin.executed"), "plugin loaded");
throw new Error("The experiment must not load target compiler plugins");
