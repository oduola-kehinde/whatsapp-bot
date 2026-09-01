const fs = require("fs");

const required = [
    "package.json",
    "package-lock.json",
    "vercel.json",
    ".env.example",
    ".gitignore",
    "api.js",
    "apps/api/index.js",
    "apps/web/index.html",
    "worker/index.js"
];

console.log("");
console.log("======================================");
console.log(" WHATSAPP AUTOMATION PLATFORM CHECK");
console.log("======================================");

let failed = false;

for (const file of required) {
    if (fs.existsSync(file)) {
        console.log("OK     " + file);
    } else {
        console.log("MISSING " + file);
        failed = true;
    }
}

try {
    JSON.parse(fs.readFileSync("package.json", "utf8"));
    console.log("OK     package.json JSON");
} catch {
    console.log("ERROR  package.json JSON");
    failed = true;
}

console.log("");

if (failed) {
    console.log("CHECK FAILED");
    process.exit(1);
}

console.log("ALL BASIC CHECKS PASSED");
